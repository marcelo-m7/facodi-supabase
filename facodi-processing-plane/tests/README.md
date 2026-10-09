# Tests

`test_current_runtime.py` preserves the explicit FACODI v3 function inventory
and excludes retired Open2 surfaces.

`test_canonical_queue.py` executes twenty-one native PostgreSQL tests: twenty real
concurrent enqueues, twenty independent claims, caller rollback, expired-lease
recovery/fencing, immutable checkpoint replay, terminal response loss/replay,
payload bounds and Public/authenticated denial. Versioned cancellation adds
twenty concurrent command replays racing a live completion, rollback, command
identity conflicts, append-only receipt history and residual-message fencing.
Versioned retry adds atomic rollback, twenty concurrent command replays, stable
job/input/checkpoint identity, prior-failure preservation, stale-message/worker
fencing and a lifetime ceiling of twenty attempts. Each explicit retry grants at
most two additional claims; it cannot revive a cancelled or successful job.
Runtime routing additionally exercises legacy Edge defaults, explicit isolated
claims, twenty concurrent mixed-runtime claims without crossing or duplication,
checkpoint recovery and old-token fencing, invalid runtime rejection and
Public/authenticated denial. A fresh four-migration install, schema lint and
security advisors passed against a disposable database.
`canonical_worker_test.ts` executes 42 Deno tests, including the actual secret
authentication wrapper/client against native SQL for unpublished completion and
versioned cancellation/retry replay and recovery of a committed analysis without
another provider call. It uses `docker exec` against
only a disposable local container and the fixed `facodi_canonical_ci` database.
It never connects to remote Supabase or production Odoo.

Automatic YouTube fixtures exercise the pinned real transcript parser through
bounded synthetic watch/player/timed-text responses, source/video identity and
transport denial, oversized text/response rejection without truncation, safe
input-required failures before enrichment, immutable acquisition checkpoints
and recovery without another acquisition or paid call. The authenticated native
SQL endpoint fixture preserves the accepted empty request and finishes with one
unpublished result. Real read-only acquisition was also exercised locally: a
short public video produced 225 bytes of English text, while the larger reference
video returned `INPUT_BUDGET_EXHAUSTED`. Those probes submitted no jobs, logged
no transcript text and do not establish remote Edge or production acceptance.

After starting local Supabase PostgreSQL and loading the queue, command, retry and runtime migrations in
that dedicated test database:

```bash
FACODI_CANONICAL_TEST_CONTAINER=supabase_db_facodi-processing-plane \
	python3 -m unittest discover -s tests -p 'test_canonical_queue.py' -v
```

The database suite skips without that explicit local environment variable;
the mandatory `canonical-database` CI job sets it and runs the native suite,
schema lint and security advisors. Static tests alone are not queue acceptance.

The isolated-worker CI additionally builds the digest-pinned image and runs it
offline as nonroot with a read-only root, no capabilities, bounded memory/CPU
and temporary storage. Five `document_worker_test.ts` checks execute the actual
API-owned PDF/DOCX converter, preserve large bounded text, reject oversized or
invalid input, deny inherited credentials and kill a stalled child. The native
converter tests require `FACODI_TEST_API_SOURCE` and never silently skip.
