# ADR-002: Odoo → Supabase learning-resource analysis contract

## Status

Accepted and implemented for the first production bridge.

## Decision

Odoo remains the editorial system of record. Supabase Edge Functions own public
resource enrichment and analysis.

The Odoo runtime invokes `v3_analyze_learning_resource` server-to-server with:

- `apikey: SUPABASE_SECRET_KEY`;
- one stable Odoo analysis-job idempotency key;
- a public source URL;
- bounded Odoo editorial context.

The Edge Function:

1. validates the Supabase secret key itself because modern `sb_secret_...` keys
   are not JWTs and the function runs with `verify_jwt=false`;
2. records/reuses an idempotent `facodi_processing_jobs` row;
3. enriches recognized YouTube URLs using public metadata only;
4. performs Gemini analysis when `GEMINI_API_KEY` is available in the function
   environment, with an authenticated Odoo header as a transitional fallback;
5. returns a normalized Odoo payload;
6. never publishes content or approves editorial/academic mappings.

## Security

The processing-jobs table has RLS enabled and no anon/authenticated grants. Secret
keys and Gemini keys are never persisted in request/result payloads.

## Follow-up

Move `GEMINI_API_KEY` into Supabase project secrets so the Odoo header fallback can
be removed. Add URL-first form enrichment as a separate public-safe endpoint that
returns metadata only and does not expose the privileged analysis function.
