"""Rehearse presentation fixtures in disposable SQLite/uploads, never production."""
import importlib.util
import json
import os
from pathlib import Path
import sys
from tempfile import TemporaryDirectory


ROOT = Path(__file__).resolve().parents[1]


def main():
    with TemporaryDirectory(prefix="report-presentation-rehearsal-") as directory:
        os.environ.update(APP_ENV="development", AUTO_MIGRATE="false", ENABLE_DEV_SEED="false",
                          DATABASE_URL="sqlite://", UPLOAD_DIR=str(Path(directory) / "uploads"),
                          UPLOAD_STORAGE_BACKEND="local", K_SERVICE="", SQL_ECHO="false")
        sys.path.insert(0, str(ROOT / "backend"))
        from sqlmodel import SQLModel, Session, create_engine
        from app.models import Department, User
        from app.schemas import WorkFormCreate, SiteCreateRequest, WorkFormSubmissionCreate, ReportTransitionRequest
        from app.use_cases.work_forms import create_work_form, create_work_form_submission, transition_report
        from app.use_cases.staff_site_admin import create_site
        from app.upload_storage import store_verified_raster

        spec = importlib.util.spec_from_file_location("presentation_live", ROOT / "scripts/presentation-demo-live.py")
        helpers = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(helpers)
        data = helpers.dataset("demo-20260916", "2026-09-16")
        engine = create_engine("sqlite://")
        SQLModel.metadata.create_all(engine)
        with Session(engine) as session:
            department = Department(name="Mutual")
            session.add(department)
            session.flush()
            supervisor = User(name="DEMO Supervisor", email="supervisor@example.invalid", role="supervisor",
                              department_id=department.id, password_hash="not-a-login-password")
            workers = {worker["key"]: User(name=worker["name"], email=f"{worker['key']}@example.invalid",
                       department_id=department.id, password_hash="not-a-login-password", role="worker", worker_class="normal")
                       for worker in data["workers"]}
            session.add_all([supervisor, *workers.values()])
            session.commit()
            templates = {item["key"]: create_work_form(WorkFormCreate(**item), supervisor, session) for item in data["templates"]}
            sites = {item["key"]: create_site(SiteCreateRequest(**item), supervisor, session) for item in data["sites"]}
            uploads = {}
            for key, worker in workers.items():
                uploads[key] = {}
                for kind in ("signature", "photo"):
                    stored = store_verified_raster(helpers.demo_image(worker.name, kind == "signature"), uploaded_by=worker.id)
                    uploads[key][kind] = f"/uploads/{stored.filename}"
            counts = {key: 0 for key in ("submitted", "in_review", "resolved")}
            for item in data["reports"]:
                key = item["workerKey"]
                report = create_work_form_submission(WorkFormSubmissionCreate(
                    form_id=templates[item["templateKey"]]["id"], expected_definition_version=1,
                    site_id=sites[item["siteKey"]]["id"] if item["siteKey"] else None,
                    work_date=item["workDate"], client_submission_id=f"rehearsal-{item['key']}",
                    answers=helpers.substitute(item["answers"], uploads[key]["signature"]),
                    photo_urls=[uploads[key]["photo"]] if item["includePhoto"] else [],
                    photo_metadata=[{"name": "DEMO illustration - not a real site photo"}] if item["includePhoto"] else [],
                ), workers[key], session)
                assert report["workflow_status"] == "submitted" and report["submission_purpose"] == "report"
                if item["workflow"] != "submitted":
                    report = transition_report(report["id"], ReportTransitionRequest(status="in_review"), supervisor, session)
                if item["workflow"] == "resolved":
                    report = transition_report(report["id"], ReportTransitionRequest(status="resolved", supervisor_note=item["finalNote"]), supervisor, session)
                assert report["workflow_status"] == item["workflow"]
                assert report["worker_id"] == workers[key].id
                counts[report["workflow_status"]] += 1
            assert counts == {"submitted": 3, "in_review": 3, "resolved": 3}
        engine.dispose()
    print(json.dumps({"status": "passed", "scope": "disposable SQLite and uploads only", "templates": 3, "reports": counts}))


if __name__ == "__main__":
    main()
