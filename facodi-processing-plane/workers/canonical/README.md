# Isolated Canonical Worker

The owner approved a separate Coolify execution service for heavy document
conversion on 2026-10-09. Supabase remains the authority for durable jobs,
leases, checkpoints, receipts and command history. This is not another engine:
the CLI and Edge endpoint use the same canonical execution boundary.

The service defaults to `FACODI_ISOLATED_WORKER_ENABLED=false`. Disabled startup
creates no client and claims no work. Enabled startup requires the exact FACODI
Supabase URL and a modern server-only secret. The pinned standard SDK permits
only the three claim/checkpoint/finish RPC paths and forbids redirects. Provider
selection, paid-call budgets, immutable checkpoints and stale-token fencing are
unchanged. The CLI reports only a safe status, never receipts or source text.
SIGTERM stops accepting work and allows the active bounded claim to finish.

The image pins Python/Deno digests, every parser dependency and API converter
source `f3258cc550ab04f712d475f87569a40ce39c8c39`. Only the existing standalone
converter is copied; Odoo and its configuration are not installed. Conversion
uses isolated Python with cleared environment and bounded stdin/stdout. Limits
remain 2 MiB source, 262144 UTF-8 text bytes, 500 PDF pages, 1000 DOCX archive
entries, 32 MiB expanded DOCX, 256 MiB child address space, 20 CPU seconds and
30 wall seconds. Text is never truncated.

Required container isolation: UID/GID 10001, read-only root, a 16 MiB temporary
filesystem, no capabilities, no new privileges, 64 PIDs, one CPU and 512 MiB
total memory. No public port, Docker socket, Odoo database credentials or
persistent Odoo/PostgreSQL volumes are permitted. Deployment must place the
worker on a separate egress network and pin this source revision exactly.

Local evidence: four CLI/SDK tests, five actual converter tests and offline
startup/parser execution in the restricted image passed. API's credential
isolation revision has exact-head CI acceptance. The owner CI makes image
construction and offline parser execution mandatory.

This is an execution foundation, not full document intake or full P2 acceptance.
Canonical intake still excludes binary and oversized payloads. Private immutable
source/catalog/result transport, accepted runtime routing, lease-budget parity,
integrated crash recovery and private productive canary remain required before
activation. No remote schema/function change or production activation is implied.