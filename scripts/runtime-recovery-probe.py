"""Fixed, embedded runtime entrypoint. Never fetches or prints credentials.

Only the existing Cloud Run DATABASE_URL binding is read, in process memory.
The recovery mode cannot migrate; production-migrate is a separate explicit payload.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qsl, urlsplit, urlunsplit

import canonical_verifier
from runtime_recovery_inventory import capture_inventory, validate_preservation, inventory_state_sha256


def require(value, code):
    if not value:
        raise ValueError(code)


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), default=str).encode()).hexdigest()


def utc():
    return datetime.now(timezone.utc).isoformat()


def connection_target(config):
    # libpq environment or URL options must not redirect/force RO before observation.
    require(not any(name.startswith("PG") and value for name, value in os.environ.items()), "libpq_environment_forbidden")
    original = os.environ.get("DATABASE_URL", "")
    parsed = urlsplit(original)
    require(parsed.scheme in ("postgresql", "postgresql+psycopg") and parsed.path == "/neondb" and
            parsed.username and parsed.password and not parsed.fragment and parsed.port in (None, 5432), "database_target_invalid")
    pairs = parse_qsl(parsed.query, keep_blank_values=True, strict_parsing=True)
    allowed = {"sslmode": {"require", "verify-full"}, "channel_binding": {"require", "prefer"}}
    require(len(dict(pairs)) == len(pairs) and all(key in allowed and value in allowed[key] for key, value in pairs), "connection_options_forbidden")
    require(dict(pairs).get("sslmode") in allowed["sslmode"], "encrypted_connection_required")
    host = parsed.hostname
    require(type(host) is str and re.fullmatch(r"ep-[a-z0-9-]+\.[a-z0-9-]+\.aws\.neon\.tech", host), "production_host_invalid")
    direct = re.sub(r"-pooler(?=\.)", "", host, count=1)
    require(hashlib.sha256(direct.encode()).hexdigest() == config["productionHostSha256"], "production_host_changed")
    if config["mode"] in ("recovery", "backup-inventory"):
        target = config["target"]
        branch, endpoint = target["branch"], target["endpoint"]
        require(re.fullmatch(r"ep-[a-z0-9-]+\.[a-z0-9-]+\.aws\.neon\.tech", endpoint["host"]) and
                endpoint["host"].split(".")[0] == endpoint["id"] and
                re.fullmatch(r"br-[a-z0-9-]+", branch["id"]) and endpoint["branch_id"] == branch["id"] and
                endpoint["type"] == "read_only" and branch["default"] is False and branch["primary"] is False and
                endpoint["host"] != direct and datetime.now(timezone.utc) < datetime.fromisoformat(branch["expires_at"].replace("Z", "+00:00")),
                "isolated_target_invalid")
        host = endpoint["host"]
    else:
        require(config["mode"] in ("production-inventory", "production-migrate") and config["target"] is None and
                config["pauseVerified"] is True, "migration_not_explicitly_gated")
        host = direct
    # Retain only the existing user/password component and known TLS query options.
    authority = parsed.netloc.rsplit("@", 1)[0] + "@" + host
    return urlunsplit(("postgresql", authority, "/neondb", parsed.query, ""))


def verify_package(config, root=Path("/app")):
    expected = config["packageFiles"]
    paths = sorted((root / "backend").rglob("*"))
    require(not any(path.is_symlink() for path in paths), "runtime_package_symlink")
    actual = [{"path": path.relative_to(root).as_posix(), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
              for path in paths if path.is_file()]
    requirement = root / "requirements.txt"
    actual.append({"path": "requirements.txt", "sha256": hashlib.sha256(requirement.read_bytes()).hexdigest()})
    actual.sort(key=lambda item: item["path"])
    require(actual == expected, "runtime_package_not_exact_build_input")
    bundled = [{"version": Path(item["path"]).stem, "checksum": item["sha256"]} for item in actual
               if re.fullmatch(r"backend/migrations/versions/\d{4}_[a-z0-9_]+\.py", item["path"])]
    require(bundled == config["contract"]["CandidateLedger"], "runtime_migration_source_bytes_changed")
    return digest(actual)


def run(config):
    started = utc()
    package_hash = verify_package(config)
    url = connection_target(config)
    verification = inventory = before = after = preservation = None
    try:
        if config["mode"] == "recovery":
            require(config["expectedBeforeSha256"] is None and config["pauseVerified"] is False, "recovery_options_invalid")
            # Execute the original canonical verifier verbatim, including natural RO.
            require("NEON_RECOVERY_DATABASE_URL" not in os.environ, "unexpected_verifier_connection_override")
            os.environ["NEON_RECOVERY_DATABASE_URL"] = url
            try:
                verification = canonical_verifier.verify()
            finally:
                os.environ.pop("NEON_RECOVERY_DATABASE_URL", None)
            expected = config["contract"]["ExpectedLedger"]
            require(verification["migrationVersions"] == [r["version"] for r in expected] and
                    verification["migrationChecksums"] == {r["version"]: r["checksum"] for r in expected}, "canonical_source_ledger_mismatch")
            inventory = capture_inventory(url, expected, natural_read_only=True)
            require(len(inventory["tables"]) == verification["publicTableCount"], "incomplete_inventory")
        elif config["mode"] == "backup-inventory":
            require(config["contract"]["ReleasePhase"] == "PreMigration" and len(config["contract"]["ExpectedLedger"]) == 27 and
                    config["pauseVerified"] is True, "unsupported_backup_inventory")
            inventory = capture_inventory(url, config["contract"]["ExpectedLedger"], natural_read_only=True)
            require(inventory_state_sha256(inventory, config["contract"]["ExpectedLedger"], True) == config["expectedBeforeSha256"],
                    "backup_inventory_not_paused_production")
        elif config["mode"] == "production-inventory":
            require(config["contract"]["ReleasePhase"] == "PreMigration" and
                    len(config["contract"]["ExpectedLedger"]) == 27 and config["expectedBeforeSha256"] is None,
                    "unsupported_production_inventory")
            inventory = capture_inventory(url, config["contract"]["ExpectedLedger"], natural_read_only=False)
        elif config["mode"] == "production-migrate":
            candidate = config["contract"]["CandidateLedger"]
            require(config["contract"]["ReleasePhase"] == "Current" and len(candidate) == 28 and
                    candidate[-2]["version"] == "0027_report_manual_site" and candidate[-1]["version"] == "0028_report_pdf_recipients", "unsupported_migration")
            before = capture_inventory(url, candidate[:-1], natural_read_only=False)
            require(digest(before) == config["expectedBeforeSha256"], "paused_inventory_changed")
            environment = dict(os.environ)
            environment.update(DATABASE_URL=url.replace("postgresql://", "postgresql+psycopg://", 1),
                               AUTO_MIGRATE="false", REPORT_PDF_EMAIL_WORKER_ENABLED="false",
                               REGISTRATION_EMAIL_ENABLED="false", SMTP_HOST="")
            # Migration output can contain provider errors: neither stream is emitted.
            result = subprocess.run([sys.executable, "-m", "app.migrations"],
                                    cwd="/app/backend", env=environment, capture_output=True, timeout=180)
            require(result.returncode == 0, "migration_command_failed")
            after = capture_inventory(url, candidate, natural_read_only=False)
            preservation = validate_preservation(before, after, candidate)
        else:
            require(False, "unsupported_runtime_mode")
        return {"schemaVersion": 1, "kind": "runtime-recovery-record", "status": "passed",
                "runId": config["runId"], "mode": config["mode"], "sourceCommit": config["sourceCommit"],
                "image": config["image"], "configSha256": digest(config), "packageSha256": package_hash,
                "startedAtUtc": started, "completedAtUtc": utc(), "verification": verification,
                "inventory": inventory, "before": before, "after": after, "preservation": preservation}
    finally:
        url = None


def main(config):
    try:
        record = run(config)
    except Exception:
        print('RUNTIME_RECOVERY_V1 {"schemaVersion":1,"status":"failed","failureCode":"runtime_verification_failed"}', flush=True)
        return 1
    print("RUNTIME_RECOVERY_V1 " + json.dumps(record, sort_keys=True, separators=(",", ":")), flush=True)
    return 0
