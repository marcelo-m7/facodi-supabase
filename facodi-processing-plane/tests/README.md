# Tests

`test_current_runtime.py` preserves the explicit FACODI v3 function inventory
and excludes retired Open2 surfaces.

`test_canonical_queue.py` executes seven native PostgreSQL tests: twenty real
concurrent enqueues, twenty independent claims, caller rollback, expired-lease
recovery/fencing, immutable checkpoint replay, terminal response loss/replay,
payload bounds and Public/authenticated denial. It uses `docker exec` against
only a disposable local container and the fixed `facodi_canonical_ci` database.
It never connects to remote Supabase or production Odoo.

After starting local Supabase PostgreSQL and loading the candidate migration in
that dedicated test database:

```bash
FACODI_CANONICAL_TEST_CONTAINER=supabase_db_facodi-processing-plane \
	python3 -m unittest discover -s tests -p 'test_canonical_queue.py' -v
```

The database suite skips without that explicit local environment variable;
the mandatory `canonical-database` CI job sets it and runs the native suite,
schema lint and security advisors. Static tests alone are not queue acceptance.
