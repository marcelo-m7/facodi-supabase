alter table public.facodi_canonical_jobs
	add column analysis_attempt_limit bigint not null default 2
		check (analysis_attempt_limit between 2 and 20);
alter table public.facodi_canonical_commands drop constraint facodi_canonical_commands_command_check;
alter table public.facodi_canonical_commands add constraint facodi_canonical_commands_command_check
	check (command in ('cancel', 'retry'));

create function public.facodi_canonical_retry(
	p_job_id uuid, p_task_ref text, p_company_id bigint, p_cohort text,
	p_command_id uuid, p_expected_revision bigint
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
	job public.facodi_canonical_jobs;
	accepted_command public.facodi_canonical_commands;
	prior_receipt jsonb;
	response jsonb;
begin
	if p_command_id is null or p_expected_revision is null or p_expected_revision < 0 then
		raise exception 'invalid_canonical_command' using errcode = '22023';
	end if;
	select * into strict job from public.facodi_canonical_jobs
		where id = p_job_id and task_ref = p_task_ref
			and company_id = p_company_id and cohort = p_cohort for update;
	select * into accepted_command from public.facodi_canonical_commands where id = p_command_id;
	if found then
		if accepted_command.job_id <> job.id or accepted_command.command <> 'retry'
			or accepted_command.expected_revision <> p_expected_revision then
			raise exception 'canonical_command_identity_conflict' using errcode = '22023';
		end if;
		return accepted_command.response;
	end if;
	if job.command_revision <> p_expected_revision or job.status <> 'failed' or job.attempt >= 20 then
		raise exception 'canonical_retry_conflict' using errcode = '40001';
	end if;
	prior_receipt = public.facodi_canonical_receipt(job.id, job.task_ref, job.company_id, job.cohort);
	perform pgmq.archive('facodi_canonical_analysis', job.queue_message_id);
	update public.facodi_canonical_jobs set status = 'queued',
		claim_token = null, lease_until = null, result = '{}'::jsonb,
		analysis_attempt_limit = least(20, job.attempt + 2),
		queue_message_id = (select pgmq.send('facodi_canonical_analysis', jsonb_build_object('job_id', job.id))),
		command_revision = command_revision + 1, revision = revision + 1,
		updated_at = clock_timestamp() where id = job.id returning * into job;
	response = jsonb_build_object('command_id', p_command_id,
		'command_revision', job.command_revision,
		'receipt', public.facodi_canonical_receipt(job.id, job.task_ref, job.company_id, job.cohort));
	insert into public.facodi_canonical_commands
		(id, job_id, command, expected_revision, command_revision, prior_receipt, response)
		values (p_command_id, job.id, 'retry', p_expected_revision,
			job.command_revision, prior_receipt, response);
	return response;
end;
$$;
revoke all on function public.facodi_canonical_retry(uuid, text, bigint, text, uuid, bigint)
	from public, anon, authenticated;
grant execute on function public.facodi_canonical_retry(uuid, text, bigint, text, uuid, bigint)
	to service_role;

create or replace function public.facodi_canonical_claim()
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
	message pgmq.message_record;
	job public.facodi_canonical_jobs;
begin
	select * into message from pgmq.read('facodi_canonical_analysis', 120, 1);
	if not found then return null; end if;
	select * into strict job from public.facodi_canonical_jobs
		where id = (message.message ->> 'job_id')::uuid for update;
	if job.status not in ('queued', 'processing') or job.queue_message_id is distinct from message.msg_id then
		perform pgmq.archive('facodi_canonical_analysis', message.msg_id);
		return null;
	end if;
	if job.attempt >= 20 or (job.attempt >= job.analysis_attempt_limit and not (job.checkpoint ? 'analysis')) then
		update public.facodi_canonical_jobs set status = 'failed',
			claim_token = null, lease_until = null,
			result = jsonb_build_object('error_code', 'ATTEMPT_BUDGET_EXHAUSTED'),
			revision = revision + 1, updated_at = clock_timestamp() where id = job.id;
		perform pgmq.archive('facodi_canonical_analysis', message.msg_id);
		return null;
	end if;
	update public.facodi_canonical_jobs set status = 'processing',
		attempt = attempt + 1, claim_token = gen_random_uuid(),
		lease_until = message.vt, revision = revision + 1,
		updated_at = clock_timestamp()
		where id = job.id returning * into job;
	return to_jsonb(job);
end;
$$;
