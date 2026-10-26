"""Run only disposable local suites, without inherited application/cloud settings."""

import argparse
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
from tempfile import TemporaryDirectory


ROOT = Path(__file__).resolve().parents[2]
BACKEND_SUITES = (
    "database_test.py",
    "maintenance_test.py",
    "migration_test.py",  # Includes CLI and durable purpose-correction checks.
    "security_test.py",
    "registration_email_test.py",
    "invitation_email_test.py",
    "report_pdf_email_test.py",
    "report_corrections_test.py",
    "report_manual_site_test.py",
    "supervisor_report_submission_test.py",
    "upload_storage_test.py",
    "work_form_definition_test.py",
    "review_queue_test.py",
    "report_workflow_test.py",
    "report_purpose_test.py",
    "report_export_test.py",
    "report_export_evidence_test.py",
    "report_photo_limit_test.py",
    "report_pdf_branding_test.py",
    "report_pdf_layout_test.py",
    "report_pdf_unicode_test.py",
    "report_pdf_volume_test.py",
    "template_edit_test.py",
    "template_source_support_test.py",
    "invitation_test.py",
    "staff_invitation_test.py",
    "password_recovery_test.py",
    "report_upload_recovery_test.py",
    "report_review_order_test.py",
)


def isolated_environment(directory):
    # Keep only process/runtime discovery; do not forward credentials, PG settings,
    # hosted targets, test filters, debug flags, or external application settings.
    allowed = {
        "PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "HOME", "USERPROFILE",
        "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "APPDATA", "PROGRAMDATA",
        "PROGRAMFILES", "PROGRAMFILES(X86)", "TEMP", "TMP", "TMPDIR",
        "VIRTUAL_ENV", "PLAYWRIGHT_BROWSERS_PATH", "LANG", "LC_ALL", "NUMBER_OF_PROCESSORS",
    }
    environment = {key: value for key, value in os.environ.items() if key.upper() in allowed}
    # The Python selected by setup-python must also be the one child Node scripts find.
    environment["PATH"] = str(Path(sys.executable).parent) + os.pathsep + environment.get("PATH", "")
    environment.update({
        "CI": "true", "PYTHONUNBUFFERED": "1", "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONIOENCODING": "utf-8", "NO_COLOR": "1", "FORCE_COLOR": "0",
        "APP_ENV": "development", "ENVIRONMENT": "development", "K_SERVICE": "",
        "DATABASE_URL": "sqlite:///" + (directory / "unused-default.db").as_posix(),
        "GEO_SECRET_KEY": secrets.token_urlsafe(48), "AUTO_MIGRATE": "false",
        "ENABLE_DEV_SEED": "false", "SQL_ECHO": "false", "AUTH_COOKIE_SECURE": "false",
        "RATE_LIMIT_ENABLED": "false", "BUSINESS_TIMEZONE": "Pacific/Auckland",
        "UPLOAD_STORAGE_BACKEND": "local", "UPLOAD_DIR": str(directory / "uploads"),
        "UPLOAD_BUCKET": "", "UPLOAD_OBJECT_PREFIX": "uploads",
        "SMTP_HOST": "", "SMTP_USERNAME": "", "SMTP_PASSWORD": "", "SMTP_FROM_EMAIL": "",
        "REGISTRATION_EMAIL_ENABLED": "false", "PUBLIC_APP_URL": "",
        "REPORT_PDF_EMAIL_WORKER_ENABLED": "false",
        "GOOGLE_APPLICATION_CREDENTIALS": "", "API_BASE_URL": "http://127.0.0.1:8000",
        "VITE_API_PROXY_TARGET": "http://127.0.0.1:8000", "VITE_DISABLE_HTTPS": "true",
    })
    return environment


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("suite", choices=("backend", "mobile"))
    args = parser.parse_args()
    with TemporaryDirectory(prefix="reportflow-ci-") as temporary:
        environment = isolated_environment(Path(temporary))
        if args.suite == "backend":
            commands = [[sys.executable, str(ROOT / ".github/scripts/check_test_server_cleanup.py")]]
            commands += [[sys.executable, str(ROOT / "backend" / name)] for name in BACKEND_SUITES]
        else:
            npm = shutil.which("npm.cmd" if os.name == "nt" else "npm", path=environment["PATH"])
            if not npm:
                raise RuntimeError("npm must be installed before running the mobile gate")
            command = [npm, "run", "check:mobile"]
            commands = [["cmd.exe", "/d", "/c", *command] if os.name == "nt" else command]
        for command in commands:
            print("Running " + (Path(command[1]).name if args.suite == "backend" else "npm run check:mobile"), flush=True)
            subprocess.run(command, cwd=ROOT, env=environment, check=True)
    print(f"{args.suite} local checks passed; temporary default storage removed", flush=True)


if __name__ == "__main__":
    main()
