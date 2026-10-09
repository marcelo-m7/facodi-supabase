alter table public.facodi_canonical_jobs add constraint facodi_canonical_runtime_check
check (not (request_payload ? 'execution_runtime') or (
	jsonb_typeof(request_payload -> 'execution_runtime') = 'string'
	and request_payload ->> 'execution_runtime' in ('edge', 'isolated')
));

create function public.facodi_canonical_claim_for_runtime(p_runtime text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
	message record;
	job public.facodi_canonical_jobs;
begin
	if p_runtime is null or p_runtime not in ('edge', 'isolated') then
		raise exception 'invalid_canonical_runtime' using errcode = '22023';
	end if;
	select queued.* into message from pgmq.q_facodi_canonical_analysis queued
		join public.facodi_canonical_jobs accepted
			on accepted.id = (queued.message ->> 'job_id')::uuid
		where queued.vt <= clock_timestamp()
			and coalesce(accepted.request_payload ->> 'execution_runtime', 'edge') = p_runtime
		order by queued.msg_id limit 1 for update of queued skip locked;
	if not found then return null; end if;
	update pgmq.q_facodi_canonical_analysis
		set vt = clock_timestamp() + interval '120 seconds', read_ct = read_ct + 1
		where msg_id = message.msg_id returning * into message;
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

revoke all on function public.facodi_canonical_claim_for_runtime(text)
	from public, anon, authenticated;
grant execute on function public.facodi_canonical_claim_for_runtime(text) to service_role;

create or replace function public.facodi_canonical_claim()
returns jsonb language sql security invoker set search_path = '' as $$
	select public.facodi_canonical_claim_for_runtime('edge');
$$;
