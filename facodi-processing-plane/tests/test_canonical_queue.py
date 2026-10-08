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
            "truncate public.facodi_canonical_commands, public.facodi_canonical_jobs, "
            "pgmq.q_facodi_canonical_analysis, pgmq.a_facodi_canonical_analysis",
            role="postgres",
        )
        self.task_ref = "task:" + str(uuid4())

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

    def test_versioned_cancel_replays_and_fences_the_previous_worker(self):
        accepted = self.enqueue()
        job = self.claim()
        command_id = str(uuid4())
        query = (
            "select public.facodi_canonical_cancel("
            f"'{job['id']}', '{self.task_ref}', 1, 'p2', '{command_id}', 0)"
        )
        cancelled = json.loads(self.sql(query))
        self.assertEqual(cancelled['receipt']['status'], 'cancelled')
        self.assertEqual(cancelled['receipt']['job_id'], accepted['job_id'])
        self.assertEqual(cancelled['command_revision'], 1)
        self.assertEqual(json.loads(self.sql(query)), cancelled)
        with self.assertRaises(subprocess.CalledProcessError):
            self.checkpoint(job)
        with self.assertRaises(subprocess.CalledProcessError):
            self.finish(job)
        self.assertEqual(self.sql('select count(*) from pgmq.q_facodi_canonical_analysis'), '0')

    def test_cancel_rejects_scope_and_command_revision_without_mutation(self):
        accepted = self.enqueue()
        for company_id, revision in [(2, 0), (1, 1), (1, -1)]:
            with self.assertRaises(subprocess.CalledProcessError):
                self.sql(
                    "select public.facodi_canonical_cancel("
                    f"'{accepted['job_id']}', '{self.task_ref}', {company_id}, 'p2', '{uuid4()}', {revision})"
                )
        self.assertEqual(self.sql('select status from public.facodi_canonical_jobs'), 'queued')
        self.assertEqual(self.sql('select count(*) from pgmq.q_facodi_canonical_analysis'), '1')

    def test_cancel_rollback_and_command_identity_preserve_the_prior_receipt(self):
        self.enqueue()
        job = self.claim()
        self.checkpoint(job)
        command_id = str(uuid4())
        query = (
            "select public.facodi_canonical_cancel("
            f"'{job['id']}', '{self.task_ref}', 1, 'p2', '{command_id}', 0)"
        )
        self.sql(f"begin; {query}; rollback")
        self.assertEqual(self.sql('select status from public.facodi_canonical_jobs'), 'processing')
        self.assertEqual(self.sql('select count(*) from public.facodi_canonical_commands'), '0')
        self.assertEqual(self.sql('select count(*) from pgmq.q_facodi_canonical_analysis'), '1')
        first = json.loads(self.sql(query))
        prior = json.loads(self.sql('select prior_receipt from public.facodi_canonical_commands'))
        self.assertEqual(prior['status'], 'processing')
        with self.assertRaises(subprocess.CalledProcessError):
            self.sql(query[:-2] + '1)')
        self.task_ref = 'task:' + str(uuid4())
        other = self.enqueue()
        with self.assertRaises(subprocess.CalledProcessError):
            self.sql(
                "select public.facodi_canonical_cancel("
                f"'{other['job_id']}', '{self.task_ref}', 1, 'p2', '{command_id}', 0)"
            )
        self.assertEqual(json.loads(self.sql(query)), first)
        self.assertEqual(self.sql('select count(*) from public.facodi_canonical_commands'), '1')
        for mutation in ('update public.facodi_canonical_commands set response = \'{}\'',
                         'delete from public.facodi_canonical_commands'):
            with self.assertRaises(subprocess.CalledProcessError):
                self.sql(mutation)

    def test_real_concurrent_cancel_and_finish_keep_one_audited_cancellation(self):
        self.enqueue()
        job = self.claim()
        query = (
            "select public.facodi_canonical_cancel("
            f"'{job['id']}', '{self.task_ref}', 1, 'p2', '{uuid4()}', 0)"
        )
        with ThreadPoolExecutor(max_workers=8) as executor:
            finishing = executor.submit(self.finish, job)
            responses = list(executor.map(lambda _: self.sql(query), range(20)))
            try:
                finishing.result()
            except subprocess.CalledProcessError as error:
                self.assertIn('stale_claim', error.stderr)
        self.assertEqual(len(set(responses)), 1)
        self.assertEqual(self.sql('select status from public.facodi_canonical_jobs'), 'cancelled')
        self.assertEqual(self.sql('select count(*) from public.facodi_canonical_commands'), '1')
        self.assertEqual(self.sql('select count(*) from pgmq.a_facodi_canonical_analysis'), '1')
        prior = json.loads(self.sql('select prior_receipt from public.facodi_canonical_commands'))
        self.assertIn(prior['status'], ('processing', 'needs_review'))
        self.assertIsNone(self.claim())

    def test_cancelled_job_with_residual_message_never_runs(self):
        accepted = self.enqueue()
        cancelled = json.loads(self.sql(
            "select public.facodi_canonical_cancel("
            f"'{accepted['job_id']}', '{self.task_ref}', 1, 'p2', '{uuid4()}', 0)"
        ))
        self.sql("select pgmq.send('facodi_canonical_analysis', "
                 f"jsonb_build_object('job_id', '{accepted['job_id']}'))")
        self.assertIsNone(self.claim())
        current = json.loads(self.sql(
            "select public.facodi_canonical_receipt("
            f"'{accepted['job_id']}', '{self.task_ref}', 1, 'p2')"
        ))
        self.assertEqual(current, cancelled['receipt'])
        self.assertEqual(self.sql('select count(*) from pgmq.q_facodi_canonical_analysis'), '0')

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
                "select public.facodi_canonical_enqueue('task:' || gen_random_uuid()::text, 1, 'p2', "
                "jsonb_build_object('text', repeat('x', 65536)))"
            )

    def test_public_roles_cannot_read_or_execute(self):
        for role in ("anon", "authenticated"):
            for query in (
                "select * from public.facodi_canonical_jobs",
                "select * from public.facodi_canonical_commands",
                "select public.facodi_canonical_cancel(gen_random_uuid(), 'task:' || gen_random_uuid()::text, 1, 'p2', gen_random_uuid(), 0)",
                "select public.facodi_canonical_claim()",
                "select public.facodi_canonical_receipt(gen_random_uuid(), 'task:' || gen_random_uuid()::text, 1, 'p2')",
                "select * from pgmq.q_facodi_canonical_analysis",
            ):
                with self.subTest(role=role, query=query):
                    with self.assertRaises(subprocess.CalledProcessError):
                        self.sql(query, role=role)

    def test_receipt_requires_all_native_identity_dimensions(self):
        accepted = self.enqueue()
        query = "select public.facodi_canonical_receipt('%s', '%s', %s, '%s')"
        values = (accepted['job_id'], self.task_ref, 1, 'p2')
        self.assertEqual(json.loads(self.sql(query % values)), accepted)
        for changed in [(str(uuid4()), self.task_ref, 1, 'p2'),
                        (accepted['job_id'], 'task:' + str(uuid4()), 1, 'p2'),
                        (accepted['job_id'], self.task_ref, 2, 'p2'),
                        (accepted['job_id'], self.task_ref, 1, 'legacy')]:
            self.assertEqual(self.sql(query % changed), '')
        with self.assertRaises(subprocess.CalledProcessError):
            self.sql("select public.facodi_canonical_enqueue('%s', 1, 'p2', '{}')" % uuid4())


if __name__ == "__main__":
    unittest.main()