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

## Initial bootstrap

The first implementation cut preserves live Open2 function snapshots under `snapshots/live-open2/` and materializes selected captured functions into `supabase/functions/`.

That bootstrap is intentionally conservative:

- raw captured artifacts are stored verbatim for provenance;
- extracted function files are generated from those artifacts;
- later refactors should keep a clear diff from the captured baseline.

## Layout

```text
supabase/
  config.toml
  functions/
  migrations/

docs/
  adr/
  live-function-inventory.md

scripts/
  extract_live_function_snapshot.py

snapshots/
  live-open2/

tests/
```

## Workflow

1. Capture the currently deployed FACODI-relevant Edge Functions and schema contracts.
2. Commit the raw snapshots.
3. Extract the function sources into `supabase/functions/`.
4. Refactor toward queue-driven v3 workers with append-only analysis history and idempotent Odoo sync.
