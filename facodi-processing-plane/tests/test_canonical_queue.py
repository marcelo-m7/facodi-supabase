from concurrent.futures import ThreadPoolExecutor
import json
import os
import subprocess
import unittest
from uuid import uuid4


CONTAINER = os.environ.get("FACODI_CANONICAL_TEST_CONTAINER")


@unittest.skipUnless(CONTAINER, "requires disposable Supabase PostgreSQL")
class CanonicalQueueDatabaseTests(unittest.TestCase):
    def sql(self, query, role="service_role"):
        if not CONTAINER.startswith(("supabase_db_", "facodi_canonical_test_")):
            raise RuntimeError("Only a disposable test container is allowed")
        completed = subprocess.run(
            ["docker", "exec", CONTAINER, "psql", "-X", "-qAt",
             "-v", "ON_ERROR_STOP=1", "-U", "postgres",
             "-d", "facodi_canonical_ci", "-c", f"set role {role}; {query}"],
            check=True, capture_output=True, text=True, timeout=30,
        )
        return completed.stdout.strip()

    def setUp(self):
        self.sql(
            "truncate public.facodi_canonical_jobs, "
            "pgmq.q_facodi_canonical_analysis, pgmq.a_facodi_canonical_analysis",
            role="postgres",
        )
        self.task_ref = str(uuid4())

    def enqueue(self, payload='{"source_url":"https://example.org/test"}'):
        return json.loads(self.sql(
            "select public.facodi_canonical_enqueue("
            f"'{self.task_ref}', 1, 'p2', '{payload}')"
        ))

    def claim(self):
        value = self.sql("select public.facodi_canonical_claim()")
        return json.loads(value) if value else None

    def checkpoint(self, job, value='{"title":"Evidence"}'):
        return int(self.sql(
            "select public.facodi_canonical_checkpoint("
            f"'{job['id']}', '{job['claim_token']}', 'metadata', '{value}')"
        ))

    def finish(self, job, result='{"summary":"Unpublished evidence"}'):
        return json.loads(self.sql(
            "select public.facodi_canonical_finish("
            f"'{job['id']}', '{job['claim_token']}', 'needs_review', '{result}')"
        ))

    def expire(self, job):
        self.sql(
            "update public.facodi_canonical_jobs set lease_until = now() - "
            f"interval '1 second' where id = '{job['id']}'; "
            "update pgmq.q_facodi_canonical_analysis set vt = now() - "
            f"interval '1 second' where msg_id = {job['queue_message_id']}",
            role="postgres",
        )

    def test_real_concurrent_enqueue_has_one_job_and_one_message(self):
        with ThreadPoolExecutor(max_workers=8) as executor:
            receipts = list(executor.map(lambda _: self.enqueue(), range(20)))
        self.assertEqual(len({receipt["job_id"] for receipt in receipts}), 1)
        self.assertEqual(self.sql("select count(*) from public.facodi_canonical_jobs"), "1")
        self.assertEqual(self.sql("select count(*) from pgmq.q_facodi_canonical_analysis"), "1")
        with self.assertRaises(subprocess.CalledProcessError):
            self.enqueue('{"source_url":"https://example.org/replaced"}')

    def test_real_concurrent_claim_has_one_live_worker(self):
        self.enqueue()
        with ThreadPoolExecutor(max_workers=8) as executor:
            claims = list(executor.map(lambda _: self.claim(), range(20)))
        self.assertEqual(sum(job is not None for job in claims), 1)

    def test_caller_rollback_leaves_no_job_or_message(self):
        self.sql(
            "begin; select public.facodi_canonical_enqueue("
            f"'{self.task_ref}', 1, 'p2', '{{}}'); rollback;"
        )
        self.assertEqual(self.sql("select count(*) from public.facodi_canonical_jobs"), "0")
        self.assertEqual(self.sql("select count(*) from pgmq.q_facodi_canonical_analysis"), "0")

    def test_crash_recovery_preserves_checkpoint_and_fences_old_worker(self):
        self.enqueue()
        old = self.claim()
        revision = self.checkpoint(old)
        self.expire(old)
        recovered = self.claim()
        self.assertEqual(recovered["id"], old["id"])
        self.assertEqual(recovered["attempt"], 2)
        self.assertGreater(recovered["revision"], revision)
        self.assertNotEqual(recovered["claim_token"], old["claim_token"])
        self.assertEqual(recovered["checkpoint"]["metadata"]["title"], "Evidence")
        with self.assertRaises(subprocess.CalledProcessError):
            self.checkpoint(old)
        with self.assertRaises(subprocess.CalledProcessError):
            self.finish(old)
        self.finish(recovered)

    def test_lost_terminal_response_replays_without_another_message(self):
        accepted = self.enqueue()
        job = self.claim()
        first = self.finish(job)
        self.assertEqual(self.finish(job), first)
        self.assertEqual(self.enqueue(), first)
        self.assertEqual(first["job_id"], accepted["job_id"])
        self.assertIsNone(self.claim())
        self.assertEqual(self.sql("select count(*) from pgmq.a_facodi_canonical_analysis"), "1")
        with self.assertRaises(subprocess.CalledProcessError):
            self.finish(job, '{"summary":"Replacement"}')

    def test_checkpoint_replay_is_immutable_and_payload_is_bounded(self):
        self.enqueue()
        job = self.claim()
        revision = self.checkpoint(job)
        self.assertEqual(self.checkpoint(job), revision)
        with self.assertRaises(subprocess.CalledProcessError):
            self.checkpoint(job, '{"title":"Replacement"}')
        with self.assertRaises(subprocess.CalledProcessError):
            self.sql(
                "select public.facodi_canonical_enqueue(gen_random_uuid(), 1, 'p2', "
                "jsonb_build_object('text', repeat('x', 65536)))"
            )

    def test_public_roles_cannot_read_or_execute(self):
        for role in ("anon", "authenticated"):
            for query in (
                "select * from public.facodi_canonical_jobs",
                "select public.facodi_canonical_claim()",
                "select * from pgmq.q_facodi_canonical_analysis",
            ):
                with self.subTest(role=role, query=query):
                    with self.assertRaises(subprocess.CalledProcessError):
                        self.sql(query, role=role)


if __name__ == "__main__":
    unittest.main()