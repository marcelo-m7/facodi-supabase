create extension if not exists pgmq;
select pgmq.create('facodi_canonical_analysis');

create table public.facodi_canonical_jobs (
	id uuid primary key default gen_random_uuid(),
	task_ref text not null check (task_ref ~ '^task:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
	company_id bigint not null check (company_id > 0),
	cohort text not null check (cohort = 'p2'),
	request_payload jsonb not null check (
		jsonb_typeof(request_payload) = 'object'
		and octet_length(request_payload::text) <= 65536
	),
	queue_message_id bigint unique,
	status text not null default 'queued'
		check (status in ('queued', 'processing', 'needs_review', 'failed')),
	attempt bigint not null default 0,
	claim_token uuid,
	lease_until timestamptz,
	checkpoint jsonb not null default '{}'::jsonb,
	result jsonb not null default '{}'::jsonb,
	revision bigint not null default 1,
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now(),
	unique (company_id, task_ref)
);

alter table public.facodi_canonical_jobs enable row level security;
revoke all on public.facodi_canonical_jobs from public, anon, authenticated;
grant select, insert, update on public.facodi_canonical_jobs to service_role;
alter table pgmq.q_facodi_canonical_analysis enable row level security;
alter table pgmq.a_facodi_canonical_analysis enable row level security;
revoke all on pgmq.q_facodi_canonical_analysis, pgmq.a_facodi_canonical_analysis
	from public, anon, authenticated;
grant usage on schema pgmq to service_role;
grant select, insert, update, delete on pgmq.q_facodi_canonical_analysis,
	pgmq.a_facodi_canonical_analysis to service_role;
grant usage, select on sequence pgmq.q_facodi_canonical_analysis_msg_id_seq
	to service_role;

create function public.facodi_canonical_enqueue(
	p_task_ref text, p_company_id bigint, p_cohort text, p_request jsonb
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
	job public.facodi_canonical_jobs;
	inserted_id uuid;
begin
	insert into public.facodi_canonical_jobs
		(task_ref, company_id, cohort, request_payload)
	values (p_task_ref, p_company_id, p_cohort, p_request)
	on conflict (company_id, task_ref) do nothing returning id into inserted_id;
	select * into strict job from public.facodi_canonical_jobs
		where company_id = p_company_id and task_ref = p_task_ref for update;
	if job.cohort is distinct from p_cohort
		or job.request_payload is distinct from p_request then
		raise exception 'canonical_identity_conflict' using errcode = '22023';
	end if;
	if inserted_id is not null then
		update public.facodi_canonical_jobs
			set queue_message_id = (select pgmq.send('facodi_canonical_analysis',
				jsonb_build_object('job_id', job.id)))
			where id = job.id;
	end if;
	return jsonb_build_object('job_id', job.id, 'task_ref', job.task_ref,
		'company_id', job.company_id, 'cohort', job.cohort,
		'revision', job.revision, 'status', job.status, 'result', job.result, 'attempt', job.attempt);
end;
$$;

create function public.facodi_canonical_claim()
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
	message pgmq.message_record;
	job public.facodi_canonical_jobs;
begin
	select * into message from pgmq.read('facodi_canonical_analysis', 120, 1);
	if not found then return null; end if;
	select * into strict job from public.facodi_canonical_jobs
		where id = (message.message ->> 'job_id')::uuid for update;
	if job.status in ('needs_review', 'failed') then
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

create function public.facodi_canonical_checkpoint(
	p_job_id uuid, p_token uuid, p_key text, p_value jsonb
) returns bigint language plpgsql security invoker set search_path = '' as $$
declare
	job public.facodi_canonical_jobs;
begin
	if p_key is null or p_key not in ('metadata', 'analysis')
		or p_value is null or jsonb_typeof(p_value) <> 'object'
		or octet_length(p_value::text) > 65536 then
		raise exception 'invalid_checkpoint' using errcode = '22023';
	end if;
	select * into strict job from public.facodi_canonical_jobs
		where id = p_job_id for update;
	if job.status <> 'processing' or job.claim_token is distinct from p_token
		or job.lease_until <= clock_timestamp() then
		raise exception 'stale_claim' using errcode = '55000';
	end if;
	if job.checkpoint ? p_key then
		if job.checkpoint -> p_key is distinct from p_value then
			raise exception 'checkpoint_conflict' using errcode = '22023';
		end if;
		return job.revision;
	end if;
	update public.facodi_canonical_jobs
		set checkpoint = checkpoint || jsonb_build_object(p_key, p_value),
			revision = revision + 1, updated_at = clock_timestamp()
		where id = job.id returning revision into job.revision;
	return job.revision;
end;
$$;

create function public.facodi_canonical_finish(
	p_job_id uuid, p_token uuid, p_status text, p_result jsonb
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
	job public.facodi_canonical_jobs;
begin
	if p_status is null or p_status not in ('needs_review', 'failed')
		or p_result is null or jsonb_typeof(p_result) <> 'object'
		or octet_length(p_result::text) > 65536 then
		raise exception 'invalid_terminal_result' using errcode = '22023';
	end if;
	select * into strict job from public.facodi_canonical_jobs
		where id = p_job_id for update;
	if job.claim_token is distinct from p_token then
		raise exception 'stale_claim' using errcode = '55000';
	end if;
	if job.status in ('needs_review', 'failed') then
		if job.status <> p_status or job.result is distinct from p_result then
			raise exception 'terminal_conflict' using errcode = '22023';
		end if;
	else
		if job.status <> 'processing' or job.lease_until <= clock_timestamp() then
			raise exception 'stale_claim' using errcode = '55000';
		end if;
		update public.facodi_canonical_jobs set status = p_status, result = p_result,
			revision = revision + 1, updated_at = clock_timestamp()
			where id = job.id returning * into job;
		perform pgmq.archive('facodi_canonical_analysis', job.queue_message_id);
	end if;
	return jsonb_build_object('job_id', job.id, 'task_ref', job.task_ref,
		'company_id', job.company_id, 'cohort', job.cohort,
		'revision', job.revision, 'status', job.status, 'result', job.result, 'attempt', job.attempt);
end;
$$;

create function public.facodi_canonical_receipt(
	p_job_id uuid, p_task_ref text, p_company_id bigint, p_cohort text
) returns jsonb language sql security invoker set search_path = '' as $$
	select jsonb_build_object('job_id', id, 'task_ref', task_ref,
		'company_id', company_id, 'cohort', cohort, 'revision', revision,
		'status', status, 'result', result, 'attempt', attempt)
	from public.facodi_canonical_jobs
	where id = p_job_id and task_ref = p_task_ref
		and company_id = p_company_id and cohort = p_cohort;
$$;

revoke all on function public.facodi_canonical_receipt(uuid, text, bigint, text)
	from public, anon, authenticated;
grant execute on function public.facodi_canonical_receipt(uuid, text, bigint, text)
	to service_role;

revoke all on function public.facodi_canonical_enqueue(text, bigint, text, jsonb),
	public.facodi_canonical_claim(),
	public.facodi_canonical_checkpoint(uuid, uuid, text, jsonb),
	public.facodi_canonical_finish(uuid, uuid, text, jsonb)
	from public, anon, authenticated;
grant execute on function public.facodi_canonical_enqueue(text, bigint, text, jsonb),
	public.facodi_canonical_claim(),
	public.facodi_canonical_checkpoint(uuid, uuid, text, jsonb),
	public.facodi_canonical_finish(uuid, uuid, text, jsonb) to service_role;
