# Tests

`test_current_runtime.py` preserves the explicit FACODI v3 function inventory
and excludes retired Open2 surfaces.

`test_canonical_queue.py` executes seventeen native PostgreSQL tests: twenty real
concurrent enqueues, twenty independent claims, caller rollback, expired-lease
recovery/fencing, immutable checkpoint replay, terminal response loss/replay,
payload bounds and Public/authenticated denial. Versioned cancellation adds
twenty concurrent command replays racing a live completion, rollback, command
identity conflicts, append-only receipt history and residual-message fencing.
Versioned retry adds atomic rollback, twenty concurrent command replays, stable
job/input/checkpoint identity, prior-failure preservation, stale-message/worker
fencing and a lifetime ceiling of twenty attempts. Each explicit retry grants at
most two additional claims; it cannot revive a cancelled or successful job.
`canonical_worker_test.ts` executes 29 Deno tests, including the actual secret
authentication wrapper/client against native SQL for unpublished completion and
versioned cancellation/retry replay and recovery of a committed analysis without
another provider call. It uses `docker exec` against
only a disposable local container and the fixed `facodi_canonical_ci` database.
It never connects to remote Supabase or production Odoo.

After starting local Supabase PostgreSQL and loading the queue, command and retry migrations in
that dedicated test database:

```bash
FACODI_CANONICAL_TEST_CONTAINER=supabase_db_facodi-processing-plane \
	python3 -m unittest discover -s tests -p 'test_canonical_queue.py' -v
```

The database suite skips without that explicit local environment variable;
the mandatory `canonical-database` CI job sets it and runs the native suite,
schema lint and security advisors. Static tests alone are not queue acceptance.
