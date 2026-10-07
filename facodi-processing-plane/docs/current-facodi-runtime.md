# Current FACODI Supabase Runtime

Project ref: `bhfywztfyidvrlarebmg`.

This file is the authoritative function inventory for the FACODI Supabase project. Open2 snapshots are historical evidence only and are not runtime dependencies.

## Supported Edge Functions

| Function | Purpose | Auth | Persistence |
| --- | --- | --- | --- |
| `v3_analyze_learning_resource` | Metadata enrichment + conservative educational analysis | secret key in `apikey`; `verify_jwt=false` | `public.facodi_processing_jobs`, terminal `needs_review` |
| `v3_discover_resource_metadata` | Public-safe metadata discovery through Odoo server proxy | secret key in `apikey`; `verify_jwt=false` | none |
| `v3_ingest_youtube_video` | Canonical YouTube identity + metadata ingest | secret key in `apikey`; `verify_jwt=false` | `public.facodi_processing_jobs`, terminal `completed` |
| `v2_ingest_youtube_video` | Temporary compatibility alias for old callers | same as v3 ingest | same FACODI-native v3 ingest handler |

## Explicitly unsupported Open2 surfaces

Do not configure FACODI callers to use these historical Open2 functions:

- `v2_process_video_pipeline`
- `v2_sync_object_to_odoo`
- `v2_push_odoo_learning_object`
- the remaining historical Open2 `v2_*` catalog preserved only in Git history

Those mechanisms depended on Open2-only schemas/RPCs such as `facodi.queue_analysis_job`, `facodi.queue_odoo_sync_job`, and the old `tube`/FACODI queue topology. They are intentionally absent from the FACODI runtime.

## YouTube ingest contract

Accepted request fields are intentionally compatible with the existing Odoo caller:

```json
{
  "idempotency_key": "optional-explicit-key",
  "url": "https://www.youtube.com/watch?v=VIDEO_ID",
  "video_id": "VIDEO_ID",
  "title": "optional fallback title",
  "description": "optional fallback description",
  "channel_id": "42",
  "language": "pt_PT",
  "metadata": {
    "odoo_slide_id": 1035,
    "odoo_channel_id": 41,
    "source_model": "slide.slide"
  }
}
```

`source_url` may be used instead of `url`. The handler validates YouTube identity, derives a stable idempotency key when one is not supplied, stores bounded processing evidence, and never performs publication or editorial approval.

## Security boundary

Server-to-server callers use the privileged Supabase secret key only in the `apikey` header. Modern `sb_secret_*` values are not JWTs and must not be copied into `Authorization: Bearer`. The functions perform secret validation internally.
