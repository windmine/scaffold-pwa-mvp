"""Pure/no-network proof and resource guards for prepare-only production tooling."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from datetime import datetime, timedelta, timezone


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


cutover = load("production_cutover", "report-production-cutover.py")
fixtures = load("operator_fixtures", "report-release-operator-test.py")
operator = cutover.operator
ARTIFACT = {"sourceCommit": "a" * 40,
            "image": f"{operator.REGION}-docker.pkg.dev/{operator.PROJECT}/cloud-run-source-deploy/geo-backend@sha256:" + "b" * 64}


def inputs():
    baseline = fixtures.baseline()
    baseline.update(schemaVersion=1, phase="snapshot", status="passed", inventory={"migrationHead": "0021_worker_invitations", "migrationCount": 21})
    baseline["live"].update(revision="geo-backend-onboarding-20260925")
    baseline["live"]["runtimeSha256"] = operator.sha(baseline["live"]["runtimeSpec"])
    branch = {"id": "br-stage", "projectId": operator.NEON_PROJECT, "parentId": operator.NEON_PARENT,
              "hostSha256": operator.sha("stage-host")}
    common = {"schemaVersion": 1, "status": "passed", "runId": cutover.RUN_ID, "artifact": ARTIFACT,
              "baselineSha256": operator.sha(baseline), "productionUnchanged": True,
              "resources": operator.names(cutover.RUN_ID), "branch": branch}
    checked = {**common, "phase": "stage-check", "afterInventory": {"migrationHead": "0022_worker_password_recovery",
                "migrationCount": 22, "ledgerMatchesBundledPrefix": True}}
    stage_service = {**common, "phase": "stage-service"}
    origin = f"https://{operator.PROJECT}--release-stage-20260929-example.web.app"
    ux = {"schemaVersion": 1, "status": "passed", "runId": "stage-20260929", "origin": origin, "browserPageErrors": 0,
          "checks": [{"name": name, "status": "passed"} for name in sorted(cutover.UX_CHECKS)],
          "cleanup": {"failures": [], "reportTrashed": True, "templateArchived": True, "workerResigned": True}}
    provider = {"schemaVersion": 1, "status": "passed", "artifact": ARTIFACT, "runId": cutover.RUN_ID, "branch": branch,
                "baselineSha256": operator.sha(baseline),
                "checks": [f"check-{index}" for index in range(214)], "smokeExitCode": 0,
                "cleanupComplete": True, "localFixtureCleanupComplete": True, "productionUnchanged": True}
    validation = {"schemaVersion": 1, "status": "passed", "artifact": ARTIFACT, "baselineSha256": operator.sha(baseline),
                  "stageServiceProofSha256": operator.sha(stage_service), "stageUxProofSha256": operator.sha(ux),
                  "origin": origin, "hostingVersion": "1234567890abcdef", "stageServiceName": operator.names(cutover.RUN_ID)["service"]}
    return baseline, checked, stage_service, ux, provider, validation


def live_service(baseline):
    return {"metadata": {"name": operator.PRODUCTION, "namespace": "123456", "resourceVersion": "immutable-read-version",
                         "labels": {"cloud.googleapis.com/location": operator.REGION, "release-owner": "existing"},
                         "annotations": {**baseline["live"]["serviceAnnotations"], "run.googleapis.com/description": "Keep this",
                                         "serving.knative.dev/creator": "output-only"}},
            "spec": {"template": {"metadata": {"name": baseline["live"]["revision"], "annotations": baseline["live"]["templateAnnotations"]},
                                     "spec": baseline["live"]["runtimeSpec"]},
                     "traffic": [{"revisionName": baseline["live"]["revision"], "percent": 100}]}}


class CutoverTests(unittest.TestCase):
    def test_maintenance_changes_only_image_command_arguments_and_revision_traffic(self):
        baseline = inputs()[0]
        source = live_service(baseline)
        original = copy.deepcopy((baseline, source))
        document = cutover.maintenance_document(baseline, ARTIFACT["image"], source)
        self.assertEqual((baseline, source), original)
        runtime = document["spec"]["template"]["spec"]
        expected = copy.deepcopy(baseline["live"]["runtimeSpec"])
        expected["containers"][0].update(image=ARTIFACT["image"], command=["python", "-m", "uvicorn"],
                                          args=["app.maintenance:app", "--host", "0.0.0.0", "--port", "8080"])
        self.assertEqual(runtime, expected)
        self.assertEqual(document["metadata"]["resourceVersion"], "immutable-read-version")
        self.assertEqual(document["metadata"]["labels"], source["metadata"]["labels"])
        self.assertEqual(document["metadata"]["annotations"]["run.googleapis.com/description"], "Keep this")
        self.assertNotIn("serving.knative.dev/creator", document["metadata"]["annotations"])
        self.assertEqual(document["spec"]["traffic"], [
            {"revisionName": baseline["live"]["revision"], "percent": 100},
            {"revisionName": cutover.MAINTENANCE_REVISION, "percent": 0, "tag": cutover.MAINTENANCE_TAG}])
        self.assertNotIn("latestRevision", json.dumps(document))

    def test_job_preserves_production_secret_versions_and_never_autoruns(self):
        baseline = inputs()[0]
        document = cutover.migration_job_document(baseline, ARTIFACT["image"])
        tasks = document["spec"]["template"]["spec"]
        runtime = tasks["template"]["spec"]
        self.assertEqual((tasks["parallelism"], tasks["taskCount"], runtime["maxRetries"], runtime["timeoutSeconds"]), (1, 1, 0, "300"))
        expected = copy.deepcopy(baseline["live"]["runtimeSpec"])
        expected.pop("containerConcurrency")
        expected.update(maxRetries=0, timeoutSeconds="300")
        container = expected["containers"][0]
        container.pop("ports")
        container.pop("startupProbe")
        container.update(image=ARTIFACT["image"], command=["python"], args=["-m", "app.migrations"])
        self.assertEqual(runtime, expected)
        refs = {item["name"]: item["valueFrom"]["secretKeyRef"] for item in runtime["containers"][0]["env"] if "valueFrom" in item}
        self.assertEqual(refs, operator.SECRET_REFS)
        self.assertNotIn("execution", json.dumps(document).lower())

    def test_proofs_bind_exact_artifact_baseline_stage_branch_and_hosted_checks(self):
        values = inputs()
        cutover.validate_prerequisites(*values, ARTIFACT)
        mutations = [
            (1, lambda proof: proof.update(artifact={**ARTIFACT, "sourceCommit": "c" * 40})),
            (1, lambda proof: proof.update(baselineSha256="mismatch")),
            (1, lambda proof: proof["afterInventory"].update(migrationCount=21)),
            (2, lambda proof: proof.update(resources={"service": operator.PRODUCTION})),
            (3, lambda proof: proof["checks"].pop()),
            (3, lambda proof: proof.update(browserPageErrors=1)),
            (3, lambda proof: proof["cleanup"].update(workerResigned=False)),
            (4, lambda proof: proof.update(cleanupComplete=False)),
            (4, lambda proof: proof.update(smokeExitCode=1)),
            (4, lambda proof: proof.update(baselineSha256="unbound")),
            (4, lambda proof: proof["checks"].pop()),
            (4, lambda proof: proof["branch"].update(id=operator.NEON_PARENT)),
            (5, lambda proof: proof.update(stageUxProofSha256="unbound")),
            (5, lambda proof: proof.update(stageServiceProofSha256="unbound")),
            (5, lambda proof: proof.update(origin=f"https://{operator.PROJECT}.web.app")),
            (5, lambda proof: proof.update(stageServiceName=operator.PRODUCTION)),
        ]
        for index, mutate in mutations:
            with self.subTest(index=index, mutation=mutate):
                bad = copy.deepcopy(values)
                mutate(bad[index])
                with self.assertRaises(RuntimeError):
                    cutover.validate_prerequisites(*bad, ARTIFACT)

    def test_existing_exact_resource_names_are_never_reused(self):
        for collection, name in (("revisions", cutover.MAINTENANCE_REVISION), ("jobs", cutover.MIGRATION_JOB)):
            def cloud(*args):
                return [{"metadata": {"name": name}}] if args[1] == collection else []
            with patch.object(operator, "cloud", side_effect=cloud), self.assertRaises(RuntimeError):
                cutover.assert_new_resources()

    def test_prepared_verification_rejects_traffic_runtime_iam_and_execution_drift(self):
        baseline = inputs()[0]
        document = cutover.maintenance_document(baseline, ARTIFACT["image"], live_service(baseline))
        service = copy.deepcopy(document)
        service["status"] = {"traffic": copy.deepcopy(document["spec"]["traffic"])}
        revision = {"metadata": {"name": cutover.MAINTENANCE_REVISION},
                    "status": {"imageDigest": ARTIFACT["image"], "conditions": [{"type": "Ready", "status": "True"}]},
                    "spec": document["spec"]["template"]["spec"]}
        job = cutover.migration_job_document(baseline, ARTIFACT["image"])
        iam = {"bindings": [{"role": "roles/run.invoker", "members": ["allUsers"]}]}
        original = (baseline, ARTIFACT, document, job, service, revision, job, iam, iam, [])
        cutover.assert_prepared(*original)
        mutations = [
            (4, lambda value: value["status"]["traffic"][0].update(percent=99)),
            (4, lambda value: value["status"]["traffic"][1].update(percent=1)),
            (5, lambda value: value["spec"]["containers"][0].update(args=["app.main:app"])),
            (5, lambda value: value["status"].update(imageDigest="wrong")),
            (6, lambda value: value.update(status={"executionCount": 1})),
            (8, lambda value: value.update(bindings=[])),
            (9, lambda value: value.append({"name": "forbidden-execution"})),
        ]
        for index, mutate in mutations:
            # Copy each argument independently so a mutated returned resource
            # cannot also change the expected document or baseline.
            values = [copy.deepcopy(value) for value in original]
            mutate(values[index])
            with self.subTest(index=index), self.assertRaises(RuntimeError):
                cutover.assert_prepared(*values)

    def test_flag_and_phase_fail_before_any_external_action(self):
        with patch.object(operator, "cloud") as cloud, patch.object(operator, "candidate") as candidate:
            for args in (SimpleNamespace(phase="prepare", allow_production_cutover=False),
                         SimpleNamespace(phase="unsupported", allow_production_cutover=True)):
                with self.assertRaisesRegex(RuntimeError, "explicit_(prepare|phase)_authorization_required"):
                    cutover.run(args)
            cloud.assert_not_called()
            candidate.assert_not_called()

    def run_preparation(self, directory, fail_second_write=False):
        values = inputs()
        baseline = values[0]
        args = SimpleNamespace(phase="prepare", allow_production_cutover=True, evidence=directory / "prepare.json",
                               source_commit=ARTIFACT["sourceCommit"], image=ARTIFACT["image"])
        for key, value in zip(("snapshot", "stage_check_proof", "stage_service_proof", "stage_ux_proof",
                               "provider_smoke_proof", "stage_validation_proof"), values):
            path = directory / (key + ".json")
            path.write_text(json.dumps(value), encoding="utf-8")
            setattr(args, key, path)
        service = live_service(baseline)
        iam = {"etag": "unchanged", "bindings": [{"role": "roles/run.invoker", "members": ["allUsers"]}]}
        prepared, calls = {}, []
        inventory = {"migrationHead": "0021_worker_invitations", "migrationCount": 21, "migrationChecksums": {"0021": "same"}}

        def cloud(*command, **kwargs):
            calls.append(command)
            kind, verb = command[1:3]
            if verb == "replace":
                proof = json.loads(args.evidence.read_text())
                self.assertEqual(len(proof["attempts"]), 1 if kind == "jobs" else 2)
                self.assertFalse(proof["maintenancePaused"])
                self.assertFalse(proof["migrationExecuted"])
                if kind == "services" and fail_second_write:
                    raise RuntimeError("sensitive external output must not be copied")
                prepared[kind] = json.loads(kwargs["input_text"])
                return prepared[kind]
            if verb == "list" or kind == "jobs" and verb == "executions":
                return []
            if verb == "get-iam-policy":
                return iam
            if kind == "services" and verb == "describe":
                if "services" not in prepared:
                    return service
                result = copy.deepcopy(prepared["services"])
                result["status"] = {"traffic": result["spec"]["traffic"]}
                return result
            if kind == "jobs" and verb == "describe":
                return prepared["jobs"]
            if kind == "revisions" and verb == "describe":
                if command[3] == baseline["live"]["revision"]:
                    return {"spec": baseline["live"]["runtimeSpec"]}
                return {"metadata": {"name": cutover.MAINTENANCE_REVISION},
                        "spec": prepared["services"]["spec"]["template"]["spec"],
                        "status": {"imageDigest": ARTIFACT["image"], "conditions": [{"type": "Ready", "status": "True"}]}}
            self.fail(f"Unexpected command: {command}")

        with patch.object(operator, "cloud", side_effect=cloud), patch.object(operator, "candidate", return_value=ARTIFACT), \
                patch.object(operator, "same_live"), patch.object(operator, "inventory", return_value=inventory), \
                patch.object(operator, "read_secret", return_value="memory-only"), \
                patch.object(operator, "validate_url", return_value="ep-production.example.neon.tech"):
            result = cutover.run(args)
        return result, json.loads(args.evidence.read_text()), calls

    def test_prepare_has_only_two_journaled_writes_no_execution_or_traffic_promotion(self):
        with tempfile.TemporaryDirectory() as directory:
            result, proof, calls = self.run_preparation(Path(directory))
        self.assertEqual(result, 0)
        self.assertEqual(proof["status"], "passed")
        self.assertTrue(proof["migrationJobUnexecuted"])
        self.assertTrue(proof["productionTrafficUnchanged"])
        self.assertEqual([call[:3] for call in calls if call[2] == "replace"], [("run", "jobs", "replace"), ("run", "services", "replace")])
        self.assertFalse(any("execute" in call or "update-traffic" in call or "set-iam-policy" in call for call in calls))
        self.assertNotIn("memory-only", json.dumps(proof))

    def test_uncertain_second_write_retains_attempts_without_retry_or_secret_echo(self):
        with tempfile.TemporaryDirectory() as directory:
            result, proof, calls = self.run_preparation(Path(directory), fail_second_write=True)
        self.assertEqual(result, 1)
        self.assertEqual(proof["status"], "failed")
        self.assertEqual(len(proof["attempts"]), 2)
        self.assertEqual(len([call for call in calls if call[2] == "replace"]), 2)
        self.assertNotIn("sensitive external output", json.dumps(proof))

    def test_drain_deadline_is_a_gate_not_a_sleep(self):
        at = datetime(2026, 9, 29, tzinfo=timezone.utc)
        prepared = {"status": "passed"}
        pause = {"maintenancePaused": True, "prepareProofSha256": operator.sha(prepared), "drainSeconds": 300,
                 "maintenanceConfirmedAtUtc": at.isoformat(), "drainUntilUtc": (at + timedelta(seconds=300)).isoformat()}
        with self.assertRaisesRegex(RuntimeError, "drain_deadline_not_reached"):
            cutover.validate_pause(pause, prepared, at=at + timedelta(seconds=299))
        cutover.validate_pause(pause, prepared, at=at + timedelta(seconds=300))
        pause["drainUntilUtc"] = (at + timedelta(seconds=299)).isoformat()
        with self.assertRaisesRegex(RuntimeError, "pause_proof_not_verified"):
            cutover.validate_pause(pause, prepared, at=at + timedelta(seconds=400))

    def phase_fixture(self, directory, phase):
        baseline = inputs()[0]
        now = datetime.now(timezone.utc)
        before = {"status": "passed", "transactionReadOnly": True, "ledgerMatchesBundledPrefix": True,
                  "migrationHead": "0021_worker_invitations", "migrationCount": 21, "migrationChecksums": {"0021": "same"},
                  "immutableSubmissionsSha256": "reports", "accountCredentialsSha256": "accounts", "submissionCount": 17,
                  "templateCount": 15, "userCounts": [{"role": "worker", "count": 3}], "auditCount": 90}
        after = {**before, "migrationHead": "0022_worker_password_recovery", "migrationCount": 22,
                 "migrationChecksums": {"0021": "same", "0022": "new"}, "recoverySchema": {
                    "columnsPresent": ["auth_generation", "legacy_auth_allowed", "password_recovery_generation"],
                    "tablePresent": True, "recoveryRowCount": 0, "nullSecurityStateCount": 0, "accountCount": 3,
                    "zeroAuthGenerationCount": 3, "zeroRecoveryGenerationCount": 3, "legacyAllowedCount": 3}}
        raw_service = live_service(baseline)
        prepared_service = cutover.maintenance_document(baseline, ARTIFACT["image"], raw_service)
        prepared_service["status"] = {"url": "https://geo-backend-fixture.a.run.app", "traffic": copy.deepcopy(prepared_service["spec"]["traffic"])}
        maintenance_service = copy.deepcopy(prepared_service)
        maintenance_service["spec"]["traffic"] = [{"revisionName": cutover.MAINTENANCE_REVISION, "percent": 100}]
        maintenance_service["status"]["traffic"] = copy.deepcopy(maintenance_service["spec"]["traffic"])
        candidate_service = cutover.candidate_document(baseline, ARTIFACT, maintenance_service)
        candidate_url = f"https://{cutover.CANDIDATE_TAG}---geo-backend-fixture.a.run.app"
        candidate_service["status"] = {"url": prepared_service["status"]["url"], "traffic": copy.deepcopy(candidate_service["spec"]["traffic"])}
        candidate_service["status"]["traffic"][1]["url"] = candidate_url
        iam = {"etag": "same", "bindings": [{"role": "roles/run.invoker", "members": ["allUsers"]}]}
        common = {"schemaVersion": 1, "status": "passed", "runId": cutover.RUN_ID, "artifact": ARTIFACT,
                  "baselineSha256": operator.sha(baseline)}
        prepared = {**common, "phase": "prepare", "productionTrafficUnchanged": True, "migrationJobUnexecuted": True,
                    "maintenanceReady": True, "productionLedgerUnchanged": True, "serviceIamSha256": operator.sha(iam),
                    "serviceMetadataSha256": operator.sha(cutover.configuration_metadata(prepared_service))}
        pause = {**common, "phase": "pause", "prepareProofSha256": operator.sha(prepared), "maintenancePaused": True,
                 "maintenanceConfirmedAtUtc": (now - timedelta(seconds=302)).isoformat(), "drainSeconds": 300,
                 "drainUntilUtc": (now - timedelta(seconds=2)).isoformat()}
        backup = {**common, "phase": "production-backup", "pauseProofSha256": operator.sha(pause),
                  "databaseHostSha256": baseline["databaseHostSha256"], "snapshotAtUtc": (now - timedelta(seconds=1)).isoformat(),
                  "verifiedAtUtc": now.isoformat(), "backupBranch": {"id": "br-owned-backup", "name": "release-backup-20260929",
                    "projectId": operator.NEON_PROJECT, "parentId": operator.NEON_PARENT, "expiresAt": (now + timedelta(days=1)).isoformat()},
                  "productionInventory": before, "backupInventory": before}
        migrated = {**common, "phase": "migrate", "pauseProofSha256": operator.sha(pause), "migrationExecuted": True, "afterInventory": after}
        checked = {**common, "phase": "check", "migrationProofSha256": operator.sha(migrated), "migrationCheckPassed": True, "afterInventory": after}
        candidate = {**common, "phase": "candidate", "checkProofSha256": operator.sha(checked), "candidateRevision": cutover.CANDIDATE_REVISION,
                     "candidateUrl": candidate_url, "readiness": {"consecutivePassed": 5}}
        args = SimpleNamespace(phase=phase, allow_production_cutover=True, evidence=directory / f"{phase}-new.json",
                               source_commit=ARTIFACT["sourceCommit"], image=ARTIFACT["image"])
        for key, proof in {"snapshot": baseline, "prepare_proof": prepared, "pause_proof": pause, "backup_proof": backup,
                           "migration_proof": migrated, "check_proof": checked, "candidate_proof": candidate}.items():
            path = directory / f"{key}.json"
            path.write_text(json.dumps(proof), encoding="utf-8")
            setattr(args, key, path)
        return SimpleNamespace(args=args, baseline=baseline, before=before, after=after, iam=iam, prepared=prepared, pause=pause,
                               backup=backup, prepared_service=prepared_service, maintenance_service=maintenance_service,
                               candidate_service=candidate_service, candidate_url=candidate_url)

    def test_backup_must_be_exact_owned_after_drain_unexpired_and_match_current_data(self):
        with tempfile.TemporaryDirectory() as directory:
            fixture = self.phase_fixture(Path(directory), "migrate")
            cutover.validate_backup(fixture.backup, fixture.pause, ARTIFACT, fixture.baseline, fixture.before)
            mutations = [lambda proof: proof["backupBranch"].update(id=operator.NEON_PARENT),
                         lambda proof: proof["backupBranch"].update(parentId="other"),
                         lambda proof: proof["backupBranch"].update(expiresAt="2000-01-01T00:00:00Z"),
                         lambda proof: proof.update(snapshotAtUtc=fixture.pause["maintenanceConfirmedAtUtc"]),
                         lambda proof: proof.update(pauseProofSha256="unbound"),
                         lambda proof: proof["backupInventory"].update(accountCredentialsSha256="changed")]
            for mutate in mutations:
                bad = copy.deepcopy(fixture.backup)
                # Fixture dictionaries share an initial snapshot intentionally;
                # detach the backup copy for a one-sided corruption test.
                bad["backupInventory"] = copy.deepcopy(bad["backupInventory"])
                mutate(bad)
                with self.assertRaises(RuntimeError):
                    cutover.validate_backup(bad, fixture.pause, ARTIFACT, fixture.baseline, fixture.before)

    def test_candidate_restores_normal_entrypoint_without_early_traffic(self):
        baseline = inputs()[0]
        maintenance = cutover.maintenance_document(baseline, ARTIFACT["image"], live_service(baseline))
        document = cutover.candidate_document(baseline, ARTIFACT, maintenance)
        expected = copy.deepcopy(baseline["live"]["runtimeSpec"])
        expected["containers"][0]["image"] = ARTIFACT["image"]
        self.assertEqual(document["spec"]["template"]["spec"], expected)
        self.assertNotIn("app.maintenance:app", json.dumps(document))
        self.assertEqual(document["spec"]["traffic"], [{"revisionName": cutover.MAINTENANCE_REVISION, "percent": 100},
                                                       {"revisionName": cutover.CANDIDATE_REVISION, "percent": 0, "tag": cutover.CANDIDATE_TAG}])

    def test_readiness_is_five_bounded_probes_and_refuses_bad_origin_or_response(self):
        healthy = (200, {}, {"status": "ok", "checks": {"database": "ok", "migrations": "ok", "upload_storage": "ok"}})
        with patch.object(cutover, "http_probe", return_value=healthy) as probe:
            self.assertEqual(cutover.readiness_probes("approved-by-probe")["consecutivePassed"], 5)
            self.assertEqual(probe.call_count, 5)
        with patch.object(cutover, "http_probe", return_value=(503, {}, {})) as probe:
            with self.assertRaisesRegex(RuntimeError, "candidate_readiness_not_ready"):
                cutover.readiness_probes("approved-by-probe")
            self.assertEqual(probe.call_count, 1)
        with patch.object(cutover, "build_opener") as opener:
            for origin in ("http://geo-backend-fixture.a.run.app", "https://attacker.example", "https://geo-backend-fixture.a.run.app/path",
                           "https://geo-backend-fixture.a.run.app@attacker.example", "https://geo-backend-fixture.a.run.app:8443"):
                with self.assertRaises(RuntimeError):
                    cutover.http_probe(origin, "/health/ready")
            opener.assert_not_called()

    def test_each_later_phase_is_explicit_and_executes_only_its_own_action(self):
        for phase in ("pause", "migrate", "check", "candidate", "resume"):
            with self.subTest(phase=phase), tempfile.TemporaryDirectory() as directory:
                fixture = self.phase_fixture(Path(directory), phase)
                current_service = copy.deepcopy(fixture.prepared_service if phase == "pause" else
                                                fixture.candidate_service if phase == "resume" else fixture.maintenance_service)
                current_inventory = copy.deepcopy(fixture.before if phase in {"pause", "migrate"} else fixture.after)
                calls = []

                def cloud(*command, **kwargs):
                    nonlocal current_service, current_inventory
                    calls.append(command)
                    kind, verb = command[1:3]
                    if verb in {"update-traffic", "execute", "replace"}:
                        journal = json.loads(fixture.args.evidence.read_text())
                        self.assertEqual(len(journal["attempts"]), 1)
                    if kind == "services" and verb == "describe":
                        return copy.deepcopy(current_service)
                    if verb == "get-iam-policy":
                        return fixture.iam
                    if kind == "revisions" and verb == "describe":
                        runtime = fixture.prepared_service["spec"]["template"]["spec"] if command[3] == cutover.MAINTENANCE_REVISION else fixture.candidate_service["spec"]["template"]["spec"]
                        return {"metadata": {"name": command[3]}, "spec": runtime,
                                "status": {"imageDigest": ARTIFACT["image"], "conditions": [{"type": "Ready", "status": "True"}]}}
                    if kind == "jobs" and verb == "describe":
                        return cutover.migration_job_document(fixture.baseline, ARTIFACT["image"])
                    if verb == "list" or kind == "jobs" and verb == "executions":
                        return []
                    if kind == "jobs" and verb == "execute":
                        current_inventory = copy.deepcopy(fixture.after)
                        return {"metadata": {"name": "owned-execution"}, "status": {"conditions": [{"type": "Completed", "status": "True"}]}}
                    if kind == "services" and verb == "replace":
                        self.assertEqual(json.loads(kwargs["input_text"])["spec"], {key: value for key, value in fixture.candidate_service["spec"].items()})
                        current_service = copy.deepcopy(fixture.candidate_service)
                        return current_service
                    if kind == "services" and verb == "update-traffic":
                        if phase == "pause":
                            self.assertIn("--clear-tags", command)
                            current_service = copy.deepcopy(fixture.maintenance_service)
                        else:
                            self.assertIn("--set-tags", command)
                            current_service["status"]["traffic"] = [{"revisionName": cutover.CANDIDATE_REVISION, "percent": 100, "tag": cutover.CANDIDATE_TAG}]
                        return current_service
                    self.fail(f"Unexpected command: {command}")

                def probe(origin, path):
                    healthy = origin == fixture.candidate_url or all(row["revisionName"] == cutover.CANDIDATE_REVISION for row in current_service["status"]["traffic"])
                    if healthy:
                        return 200, {}, {"status": "ok", "checks": {"database": "ok", "migrations": "ok", "upload_storage": "ok"}}
                    return 503, {"Retry-After": "60", "Cache-Control": "no-store"}, {"detail": "Service update in progress. Please keep your draft and try again shortly."}

                with patch.object(operator, "cloud", side_effect=cloud), patch.object(operator, "candidate", return_value=ARTIFACT), \
                        patch.object(operator, "read_secret", return_value="memory-only"), patch.object(operator, "validate_url", return_value="ep-production.example.neon.tech"), \
                        patch.object(operator, "inventory", side_effect=lambda _: copy.deepcopy(current_inventory)), patch.object(cutover, "http_probe", side_effect=probe):
                    self.assertEqual(cutover.run(fixture.args), 0)
                proof = json.loads(fixture.args.evidence.read_text())
                self.assertEqual(proof["status"], "passed")
                writes = [command for command in calls if command[2] in {"update-traffic", "execute", "replace"}]
                self.assertEqual(len(writes), 1)
                self.assertEqual(writes[0][2], {"pause": "update-traffic", "migrate": "execute", "check": "execute", "candidate": "replace", "resume": "update-traffic"}[phase])
                self.assertEqual("--args=-m,app.migrations,--check" in writes[0], phase == "check")
                if phase == "pause":
                    self.assertGreaterEqual((cutover.utc(proof["drainUntilUtc"]) - cutover.utc(proof["maintenanceConfirmedAtUtc"])).total_seconds(), 300)
                self.assertNotIn("memory-only", json.dumps(proof))


if __name__ == "__main__":
    unittest.main(verbosity=2)
