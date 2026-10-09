alter table public.facodi_canonical_jobs
	add column command_revision bigint not null default 0 check (command_revision >= 0);
alter table public.facodi_canonical_jobs drop constraint facodi_canonical_jobs_status_check;
alter table public.facodi_canonical_jobs add constraint facodi_canonical_jobs_status_check
	check (status in ('queued', 'processing', 'needs_review', 'failed', 'cancelled'));

create table public.facodi_canonical_commands (
	id uuid primary key,
	job_id uuid not null references public.facodi_canonical_jobs(id),
	command text not null check (command = 'cancel'),
	expected_revision bigint not null check (expected_revision >= 0),
	command_revision bigint not null check (command_revision = expected_revision + 1),
	prior_receipt jsonb not null,
	response jsonb not null,
	created_at timestamptz not null default now(),
	unique (job_id, command_revision)
);
alter table public.facodi_canonical_commands enable row level security;
revoke all on public.facodi_canonical_commands from public, anon, authenticated, service_role;
grant select, insert on public.facodi_canonical_commands to service_role;

create function public.facodi_canonical_cancel(
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
		if accepted_command.job_id <> job.id or accepted_command.command <> 'cancel'
			or accepted_command.expected_revision <> p_expected_revision then
			raise exception 'canonical_command_identity_conflict' using errcode = '22023';
		end if;
		return accepted_command.response;
	end if;
	if job.command_revision <> p_expected_revision or job.status = 'cancelled' then
		raise exception 'canonical_command_revision_conflict' using errcode = '40001';
	end if;
	prior_receipt = public.facodi_canonical_receipt(job.id, job.task_ref, job.company_id, job.cohort);
	update public.facodi_canonical_jobs set status = 'cancelled',
		claim_token = null, lease_until = null,
		result = jsonb_build_object('error_code', 'CANCELLED_BY_OPERATOR'),
		command_revision = command_revision + 1, revision = revision + 1,
		updated_at = clock_timestamp() where id = job.id returning * into job;
	perform pgmq.archive('facodi_canonical_analysis', job.queue_message_id);
	response = jsonb_build_object('command_id', p_command_id,
		'command_revision', job.command_revision,
		'receipt', public.facodi_canonical_receipt(job.id, job.task_ref, job.company_id, job.cohort));
	insert into public.facodi_canonical_commands
		(id, job_id, command, expected_revision, command_revision, prior_receipt, response)
		values (p_command_id, job.id, 'cancel', p_expected_revision,
			job.command_revision, prior_receipt, response);
	return response;
end;
$$;
revoke all on function public.facodi_canonical_cancel(uuid, text, bigint, text, uuid, bigint)
	from public, anon, authenticated;
grant execute on function public.facodi_canonical_cancel(uuid, text, bigint, text, uuid, bigint)
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
	if job.status not in ('queued', 'processing') then
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
