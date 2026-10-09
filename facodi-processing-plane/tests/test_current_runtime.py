from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[1]
FUNCTIONS = ROOT / "supabase" / "functions"
CONFIG = ROOT / "supabase" / "config.toml"


class CurrentFacodiRuntimeContract(unittest.TestCase):
    def test_deployable_function_inventory_is_small_and_explicit(self):
        actual = {path.name for path in FUNCTIONS.iterdir() if path.is_dir()}
        self.assertEqual(
            actual,
            {
                "_shared",
                "v3_analyze_learning_resource",
                "v4_canonical_analysis",
                "v3_discover_resource_metadata",
                "v3_ingest_youtube_video",
                "v2_ingest_youtube_video",
            },
        )

    def test_config_matches_current_facodi_project_contract(self):
        config = CONFIG.read_text()
        self.assertIn('schemas = ["public"]', config)
        self.assertIn('major_version = 17', config)
        function_sections = set(
            re.findall(r"^\[functions\.([^\]]+)\]$", config, flags=re.MULTILINE)
        )
        self.assertEqual(
            function_sections,
            {
                "v3_analyze_learning_resource",
                "v4_canonical_analysis",
                "v3_discover_resource_metadata",
                "v3_ingest_youtube_video",
                "v2_ingest_youtube_video",
            },
        )
        self.assertEqual(config.count("verify_jwt = false"), 5)

    def test_open2_runtime_surfaces_are_not_deployable(self):
        forbidden = {
            "v2_process_video_pipeline",
            "v2_sync_object_to_odoo",
            "v2_push_odoo_learning_object",
            "queue_analysis_job",
            "queue_odoo_sync_job",
        }
        deployable = "\n".join(
            path.read_text(errors="replace")
            for path in FUNCTIONS.rglob("*")
            if path.is_file()
        )
        for token in forbidden:
            self.assertNotIn(token, deployable)
        self.assertFalse((ROOT / "snapshots" / "live-open2").exists())

    def test_video_compatibility_alias_delegates_to_v3_handler(self):
        canonical = (
            FUNCTIONS / "v3_ingest_youtube_video" / "index.ts"
        ).read_text()
        compatibility = (
            FUNCTIONS / "v2_ingest_youtube_video" / "index.ts"
        ).read_text()
        self.assertIn('from "../_shared/v3_video_ingest.ts"', canonical)
        self.assertIn('from "../_shared/v3_video_ingest.ts"', compatibility)
        self.assertIn('mechanism: "v3_ingest_youtube_video"', compatibility)
        self.assertIn('compatibility_alias: "v2_ingest_youtube_video"', compatibility)

    def test_current_functions_use_in_function_apikey_auth(self):
        auth = (FUNCTIONS / "_shared" / "v3_auth.ts").read_text()
        self.assertIn('req.headers.get("apikey")', auth)
        self.assertNotIn('req.headers.get("authorization")', auth.lower())


if __name__ == "__main__":
    unittest.main()
