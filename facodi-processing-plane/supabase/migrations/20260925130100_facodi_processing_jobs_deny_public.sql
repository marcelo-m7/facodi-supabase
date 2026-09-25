drop policy if exists facodi_processing_jobs_deny_public
    on public.facodi_processing_jobs;

create policy facodi_processing_jobs_deny_public
    on public.facodi_processing_jobs
    as restrictive
    for all
    to anon, authenticated
    using (false)
    with check (false);
