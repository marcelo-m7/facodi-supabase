# ADR-001: Supabase As FACODI Processing Plane

## Status

Accepted for implementation bootstrap.

## Context

FACODI already has overlapping analysis and orchestration behavior split across Supabase, Odoo addons and legacy Open2 schemas.

The target operating rule is:

> Supabase decides and analyzes. Odoo publishes, presents and governs the learning experience.

The Odoo runtime must remain lean and standard-first. The deployment repository must not bake Supabase worker code into the Odoo image.

## Decision

Create a dedicated processing-plane source repository rooted at `supabase/facodi-processing-plane` within the current workspace.

This repository owns Supabase-side artifacts only:

- schema and migrations;
- Edge Functions;
- shared helpers;
- queue worker orchestration;
- Odoo sync bridge logic;
- Supabase-side tests and docs.

The initial bootstrap stores live Open2 function snapshots verbatim and extracts selected function sources into `supabase/functions/`.

## Consequences

- The processing-plane source stays outside `addons/` and therefore outside the Odoo image build surface.
- `facodi-deploy` documents and validates the presence of this source tree, but Odoo runtime tests remain focused on the canonical Coolify stack.
- Later promotion to a standalone remote repository and git submodule should preserve the same path and ownership boundary.
- Odoo-side deterministic evaluators become compatibility fallback only once Supabase-backed equivalents are introduced.
