create table if not exists public.facodi_processing_jobs (
    id uuid primary key default gen_random_uuid(),
    idempotency_key text not null unique,
    source_url text not null,
    provider text not null default 'generic',
    external_id text,
    odoo_model text,
    odoo_res_id bigint,
    odoo_analysis_job_id bigint,
    odoo_slide_id bigint,
    odoo_channel_id bigint,
    curriculum_unit_id bigint,
    status text not null default 'queued'
        check (status in ('queued', 'processing', 'completed', 'needs_review', 'failed')),
    request_payload jsonb not null default '{}'::jsonb,
    metadata jsonb not null default '{}'::jsonb,
    analysis jsonb not null default '{}'::jsonb,
    provider_name text,
    model_name text,
    prompt_version text,
    error_code text,
    error_message text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    completed_at timestamptz
);

create index if not exists facodi_processing_jobs_status_idx
    on public.facodi_processing_jobs (status, created_at desc);

create index if not exists facodi_processing_jobs_odoo_idx
    on public.facodi_processing_jobs (odoo_model, odoo_res_id);

alter table public.facodi_processing_jobs enable row level security;

revoke all on table public.facodi_processing_jobs from anon, authenticated;
grant all on table public.facodi_processing_jobs to service_role;

comment on table public.facodi_processing_jobs is
'Idempotent processing evidence for FACODI learning resources. Odoo remains the editorial system of record.';
