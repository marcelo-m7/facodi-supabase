# FACODI Processing Plane

`facodi-processing-plane` is the source home for the FACODI Supabase Processing Plane.

It exists outside `addons/` on purpose. The Odoo runtime image in the parent `facodi-deploy` repository copies only addon sources from `addons/` plus `theme_common`; Supabase code must not leak into the Odoo image or module contract.

## Scope

This repository owns:

- Supabase schema and migrations for FACODI processing;
- Edge Functions and shared libraries;
- queue worker topology and orchestration logic;
- Odoo publication bridge contracts;
- Supabase-side tests, fixtures and operational documentation.

This repository does not own:

- Odoo addon code;
- Odoo `slide.channel` / `slide.slide` publication UX;
- deployment composition for the Odoo runtime.

## Open2 historical evidence

The Open2 project is no longer a FACODI runtime dependency. Its captured functions were removed from the current working tree so code search and agents cannot mistake them for FACODI mechanisms. Their provenance remains available in Git history before the FACODI-only cleanup.

## Layout

```text
supabase/
  config.toml
  functions/
  migrations/

docs/
  adr/
  current-facodi-runtime.md

tests/
```

## Current FACODI entry points

- `v3_analyze_learning_resource`: privileged, idempotent learning-resource enrichment + analysis for Odoo jobs.
- `v3_discover_resource_metadata`: privileged metadata-only discovery used by the public Odoo contribution form through a server-side proxy. It never runs Gemini analysis and never persists publication decisions.
- `v3_ingest_youtube_video`: privileged, metadata-only YouTube ingest. It normalizes identity, stores idempotent processing evidence in `public.facodi_processing_jobs`, and never publishes Odoo content.
- `v2_ingest_youtube_video`: temporary compatibility alias that executes the same FACODI-native v3 ingest contract. It exists only so older callers can migrate without depending on Open2.
- `v4_canonical_analysis`: additive, disabled-worker candidate for bounded durable text analysis; submit and receipt endpoints use the canonical queue, not the old v3 jobs.

All endpoints use modern Supabase secret-key authentication inside the function with `verify_jwt=false`; callers send the secret only on the `apikey` header. The browser never receives a secret key. The v4 wrapper uses pinned `@supabase/server` secret authentication; existing v3 implementations are unchanged.

The Open2-only surfaces `v2_process_video_pipeline`, `v2_sync_object_to_odoo`, and `v2_push_odoo_learning_object` are not FACODI runtime functions and must not be deployed from this repository.

## Workflow

### INC-P2 Durable Queue Candidate

The additive `facodi_canonical_queue` migration introduces an isolated logged
`pgmq` queue and `facodi_canonical_jobs`. Existing v3 functions and processing
rows are unchanged. Only `service_role` can access the new boundary functions;
Public and authenticated clients have no table or RPC access.

Enqueue is atomic with the queue message and scoped by company plus native
`task:<uuid>` reference. Identical replay returns the accepted job UUID; changed payload/cohort fails
closed. Claims have a 120-second visibility lease and a new fencing token per
attempt. Immutable metadata/analysis checkpoints survive recovery. Terminal
receipts are monotonic, replayable and never publish Odoo content.

The candidate includes bounded submit/receipt transport and a `/work` endpoint.
Worker execution requires `FACODI_CANONICAL_WORKER_ENABLED=true`; it is disabled
by default. Manual/Markdown text and explicit YouTube transcripts are limited to
12000 UTF-8 bytes. Source acquisition, binary documents and versioned commands
are not yet cut over. No input is silently truncated.

Accepted requests may carry the frozen authorized native course catalog. Its
company/Website scope and Python sorted-ASCII-JSON SHA-256 are validated before
enqueue and before acquisition or paid analysis, including Unicode/control
escaping. Mapping preserves native deterministic-v2 scores, thresholds, stable
ties, top-five ranking and unmatched concepts. Evidence terms are sorted for
stable output; Python set iteration is not claimed byte-identical. The mapping
and enriched document identity are saved in one immutable analysis checkpoint.
Recovery never repeats a paid call to regenerate mapping; inconsistent mapping
identity fails for human review. Proposals never publish or approve content.
Old immutable requests without catalog remain supported. Oversized catalogs
are rejected by the bounded wire contract, not silently reduced.

The worker preserves the accepted lexical baseline or structured Gemini model,
evidence schema and output-token budget. Missing Gemini credentials fail closed;
v3 metadata fallback is not a substitute. Gemini uses server-only
`FACODI_ENRICHMENT_API_KEY`, a bounded deadline and no redirects. At most two
claims may invoke analysis; later claims can only finish an already persisted
analysis checkpoint. A new analysis requires 75 seconds of live lease and each
RPC has a 10-second deadline. Outputs are bounded before persistence. Scheduling and
full provider/source parity remain acceptance requirements, not implied by this
endpoint.

Local evidence: eight real database tests and twenty-six Deno tests, including the
actual secret-auth wrapper and Supabase client over native SQL transactions.
They prove terminal replay, role/scope denial, crash fencing, saved-checkpoint
recovery, input/output/cost bounds and no publication. CI makes native execution
mandatory and freezes the dependency lock. No remote migration/function or Odoo
intake activation has been performed. Final API/Learning integration, runtime
image identity and private canary remain required before activation.

1. Treat the FACODI project and `docs/current-facodi-runtime.md` as the source of truth.
2. Use Git history only when historical Open2 provenance is explicitly needed.
3. Implement new mechanisms directly against the current FACODI schema and secret-key contract.
4. Preserve Odoo as the editorial system of record; Supabase persists processing evidence, not publication decisions.
