"""No-network regression checks for release infrastructure evidence flags."""
import contextlib
import copy
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("infrastructure", Path(__file__).with_name("check-report-release-infrastructure.py"))
infrastructure = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(infrastructure)

OLD = "geo-backend-onboarding-20260925"
NEW = "geo-backend-recovery-20260929"
DIGEST = "sha256:" + "a" * 64
IMAGE = f"{infrastructure.REGION}-docker.pkg.dev/{infrastructure.PROJECT}/cloud-run-source-deploy/geo-backend@{DIGEST}"


class InfrastructureTests(unittest.TestCase):
    def run_probe(self, directory, *, phase="live", migration=False, changed=False, traffic=None):
        spec = {"containers": [{"name": "old-1", "image": "old", "env": [{"name": "AUTO_MIGRATE", "value": "false"}]}]}
        new_spec = copy.deepcopy(spec)
        new_spec["containers"][0].update(image=IMAGE, name="new-1")
        if changed:
            new_spec["containers"][0]["env"][0]["value"] = "true"
        replies = [
            {"spec": spec},
            {"spec": new_spec, "metadata": {"creationTimestamp": "2026-09-29T00:00:00Z"},
             "status": {"imageDigest": IMAGE, "conditions": [{"type": "Ready", "status": "True"}]}},
            {"status": {"traffic": traffic or [{"percent": 100, "revisionName": OLD if phase == "candidate" else NEW}]}},
            {"status": "SUCCESS", "results": {"images": [{"digest": DIGEST}]},
             "source": {"storageSource": {"bucket": "build-fixture", "object": "source.tgz"}}},
            [],
        ]
        evidence = Path(directory) / "proof.json"
        args = ["--phase", phase, "--previous", OLD, "--revision", NEW, "--build", "fixture-build",
                "--source-commit", "1" * 40, "--evidence", str(evidence)]
        if migration:
            args.append("--migration-required")
        with patch.object(infrastructure, "cloud", side_effect=replies) as cloud, contextlib.redirect_stdout(io.StringIO()):
            infrastructure.main(args)
        self.assertEqual(cloud.call_args_list[0].args[3], OLD)
        return json.loads(evidence.read_text())

    def test_default_preserves_no_migration_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            self.assertFalse(self.run_probe(directory)["migrationRequired"])

    def test_explicit_migration_candidate_and_live_keep_previous_configuration_comparison(self):
        for phase in ("candidate", "live"):
            with self.subTest(phase=phase), tempfile.TemporaryDirectory() as directory:
                proof = self.run_probe(directory, phase=phase, migration=True)
                self.assertTrue(proof["migrationRequired"])
                self.assertTrue(proof["runtimeConfigurationUnchanged"])
                self.assertEqual(proof["previousRevision"], OLD)

    def test_migration_flag_does_not_relax_configuration_or_live_traffic_guards(self):
        for changes in ({"changed": True}, {"traffic": [{"percent": 100, "revisionName": OLD}]},
                        {"traffic": [{"percent": 100, "revisionName": NEW, "tag": "candidate"}]}):
            with self.subTest(changes=changes), tempfile.TemporaryDirectory() as directory, self.assertRaises(RuntimeError):
                self.run_probe(directory, migration=True, **changes)


if __name__ == "__main__":
    unittest.main(verbosity=2)
