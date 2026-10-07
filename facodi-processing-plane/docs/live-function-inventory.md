# Live Open2 Function Inventory

> Historical note (2026-10-07): this file inventories functions observed in the earlier Open2 environment. It is **not** the deployment manifest for the current FACODI Supabase project `bhfywztfyidvrlarebmg`. This file describes Open2 history only. The authoritative FACODI inventory is `docs/current-facodi-runtime.md`; do not infer deployable functions from this document.
This inventory records the FACODI-relevant Edge Functions discovered in the live Open2 Supabase project during the bootstrap of `facodi-processing-plane`.

## Captured baseline snapshots

- `v2_process_video_pipeline`
- `v2_sync_object_to_odoo`
- `v2_push_odoo_learning_object`

These snapshots remain stored verbatim under `snapshots/live-open2/functions/` for provenance. Their Open2 entry points are intentionally not present in the deployable FACODI `supabase/functions/` tree.

## Additional FACODI-oriented functions observed

- `v2_ingest_youtube_video`
- `v2_review_classification`
- `v2_get_analysis_status`
- `v2_extract_video_content`
- `v2_fetch_youtube_metadata`
- `v2_generate_embeddings`
- `v2_match_video_candidates`
- `v2_classify_video`
- `v2_fetch_youtube_channel`
- `v2_list_channel_videos`
- `v2_submit_youtube_video`
- `v2_get_video_submission_status`
- `v2_process_video_pipeline`
- `v2_submit_channel_videos`
- `v2_import_youtube_video`
- `v2_analyze_video`
- `v2_match_video_to_curriculum`
- `v2_generate_playlist`
- `v2_generate_module`
- `v2_generate_course_structure`
- `v2_push_odoo_learning_object`
- `v2_sync_object_to_odoo`

## Notes

- The function catalog currently mixes canonical FACODI candidates with older or overlapping Open2 surfaces.
- `v2_process_video_pipeline` was observed with `verify_jwt = false` and internal shared-secret authentication. That is preserved in the bootstrap config as an observation, not a final security stance.
- Future FACODI mechanisms must be implemented against the current FACODI schema. Do not copy Open2 functions into `supabase/functions/` merely because they appear in this inventory.
