"""Report collection downloads use the same scoped Find query as the inbox."""
import asyncio
import csv
import json
from contextlib import contextmanager
from io import BytesIO, StringIO
from urllib.parse import urlencode

from sqlalchemy.pool import StaticPool
from pypdf import PdfReader
from sqlmodel import Session, SQLModel, create_engine

from app.main import app, get_session, require_supervisor
from app.models import Department, User, WorkForm
from app.schemas import ReportTransitionRequest, WorkFormSubmissionCreate
from app.use_cases.work_forms import create_work_form_submission, transition_report


async def request(path, params=None):
    messages = []

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message):
        messages.append(message)

    await app({
        "type": "http", "asgi": {"version": "3.0", "spec_version": "2.4"},
        "http_version": "1.1", "method": "GET", "scheme": "http",
        "path": path, "raw_path": path.encode(),
        "query_string": urlencode(params or {}).encode(), "root_path": "",
        "headers": [], "client": ("127.0.0.1", 1), "server": ("localhost", 80),
    }, receive, send)
    start = next(message for message in messages if message["type"] == "http.response.start")
    body = b"".join(message.get("body", b"") for message in messages if message["type"] == "http.response.body")
    return start["status"], body


@contextmanager
def report_fixture():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    SQLModel.metadata.create_all(engine)
    session = Session(engine)
    department = Department(name="Export Department")
    session.add(department)
    session.flush()
    supervisor = User(department_id=department.id, email="export-supervisor@example.com", name="Export Supervisor", password_hash="test", role="supervisor")
    worker = User(department_id=department.id, email="export-worker@example.com", name="Export Worker", password_hash="test", role="worker", worker_class="leader")
    form = WorkForm(department_id=department.id, name="Inspection Report", fields_json=json.dumps([{"id": "issue", "label": "Issue", "type": "text"}]), template_purpose="report")
    session.add_all([supervisor, worker, form])
    session.commit()
    for item in (supervisor, worker, form):
        session.refresh(item)
    previous_overrides = app.dependency_overrides.copy()
    app.dependency_overrides[get_session] = lambda: session
    app.dependency_overrides[require_supervisor] = lambda: supervisor
    try:
        yield session, supervisor, worker, form
    finally:
        app.dependency_overrides.clear()
        app.dependency_overrides.update(previous_overrides)
        session.close()
        engine.dispose()


def submit(session, worker, form, answer, **options):
    return create_work_form_submission(WorkFormSubmissionCreate(
        form_id=form.id, work_date=options.pop("work_date", "2026-09-15"),
        answers={"issue": answer}, **options,
    ), worker, session)


def test_csv_find_matches_inbox():
    with report_fixture() as (session, _, worker, form):
        wanted = submit(session, worker, form, "Cracked access ladder")
        submit(session, worker, form, "Paint finish only")
        params = {"purpose": "report", "search": "ladder"}
        status, body = asyncio.run(request("/supervisor/review-queue", {**params, "kind": "form"}))
        assert status == 200, body
        assert [item["id"] for item in json.loads(body)["items"]] == [wanted["id"]]
        status, body = asyncio.run(request("/supervisor/form-submissions/export.csv", params))
        assert status == 200, body
        rows = list(csv.DictReader(StringIO(body.decode())))
        assert len(rows) == 1 and rows[0]["answer_issue"] == "Cracked access ladder", rows
    print("ok - Report CSV Find matches the inbox")


def test_document_find_matches_inbox():
    with report_fixture() as (session, _, worker, form):
        submit(session, worker, form, "Cracked access ladder")
        submit(session, worker, form, "Paint finish only")
        for extension in ("html", "pdf"):
            status, body = asyncio.run(request(f"/supervisor/form-submissions/export.{extension}", {
                "purpose": "report", "search": "ladder",
            }))
            assert status == 200, body
            content = (
                "\n".join(page.extract_text() or "" for page in PdfReader(BytesIO(body)).pages)
                if extension == "pdf" else body.decode()
            )
            assert "Cracked access ladder" in content and "Paint finish only" not in content, extension
    print("ok - Report HTML/PDF Find matches the inbox")


def test_exports_include_all_matching_pages():
    with report_fixture() as (session, _, worker, form):
        reports = [submit(session, worker, form, f"Ladder export entry {index:03d}") for index in range(51)]
        submit(session, worker, form, "Excluded paint finish")
        params = {"purpose": "report", "search": "ladder"}
        status, body = asyncio.run(request("/supervisor/review-queue", {**params, "kind": "form"}))
        first = json.loads(body)
        assert status == 200 and len(first["items"]) == 50 and first["has_more"], first
        status, body = asyncio.run(request("/supervisor/review-queue", {**params, "kind": "form", "cursor": first["next_cursor"]}))
        second = json.loads(body)
        assert status == 200 and len(second["items"]) == 1 and not second["has_more"], second
        expected_ids = {report["id"] for report in reports}
        assert {item["id"] for item in first["items"] + second["items"]} == expected_ids
        for extension in ("csv", "html", "pdf"):
            status, body = asyncio.run(request(f"/supervisor/form-submissions/export.{extension}", params))
            assert status == 200, (extension, status)
            if extension == "csv":
                assert {int(row["id"]) for row in csv.DictReader(StringIO(body.decode()))} == expected_ids
            else:
                content = (
                    "\n".join(page.extract_text() or "" for page in PdfReader(BytesIO(body)).pages)
                    if extension == "pdf" else body.decode()
                )
                assert all(f"Ladder export entry {index:03d}" in content for index in range(51)), extension
                assert "Excluded paint finish" not in content, extension
    print("ok - CSV/HTML/PDF export all 51 matches across two inbox pages")


def test_export_filter_and_department_boundaries():
    with report_fixture() as (session, supervisor, worker, form):
        foreign_department = Department(name="Private Department")
        session.add(foreign_department)
        session.flush()
        colleague = User(department_id=supervisor.department_id, email="colleague@example.com", name="Colleague", password_hash="test", role="worker")
        foreign_worker = User(department_id=foreign_department.id, email="private@example.com", name="Private Worker", password_hash="test", role="worker")
        other_form = WorkForm(department_id=supervisor.department_id, name="Other Report", fields_json=form.fields_json)
        foreign_form = WorkForm(department_id=foreign_department.id, name="Private Report", fields_json=form.fields_json)
        daywork = WorkForm(department_id=supervisor.department_id, name="Retained Daywork", fields_json=form.fields_json, template_purpose="daywork")
        session.add_all([colleague, foreign_worker, other_form, foreign_form, daywork])
        session.commit()
        wanted = submit(session, worker, form, "needle target")
        other_date = submit(session, worker, form, "needle other date", work_date="2026-09-14")
        other_worker = submit(session, colleague, form, "needle other worker")
        other_template = submit(session, worker, other_form, "needle other template")
        other_status = submit(session, worker, form, "needle other workflow")
        transition_report(other_status["id"], ReportTransitionRequest(status="in_review"), supervisor, session)
        foreign = submit(session, foreign_worker, foreign_form, "needle foreign secret")
        submit(session, worker, daywork, "needle retained daywork")
        base = {"purpose": "report", "search": "needle"}
        expected_all = {item["id"] for item in (wanted, other_date, other_worker, other_template, other_status)}
        cases = [
            ({}, expected_all),
            ({"form_id": form.id}, expected_all - {other_template["id"]}),
            ({"worker_id": worker.id}, expected_all - {other_worker["id"]}),
            ({"workflow_status": "submitted"}, expected_all - {other_status["id"]}),
            ({"record_date": "2026-09-15"}, expected_all - {other_date["id"]}),
            ({"department_id": supervisor.department_id}, expected_all),
            ({"form_id": form.id, "worker_id": worker.id, "workflow_status": "submitted", "record_date": "2026-09-15"}, {wanted["id"]}),
        ]
        for filters, expected in cases:
            params = {**base, **filters}
            status, body = asyncio.run(request("/supervisor/review-queue", {**params, "kind": "form"}))
            assert status == 200 and {item["id"] for item in json.loads(body)["items"]} == expected, filters
            export_params = {key: value for key, value in params.items() if key != "record_date"}
            if "record_date" in filters:
                export_params.update(date_from=filters["record_date"], date_to=filters["record_date"])
            status, body = asyncio.run(request("/supervisor/form-submissions/export.csv", export_params))
            assert status == 200 and {int(row["id"]) for row in csv.DictReader(StringIO(body.decode()))} == expected, filters
        combined = {
            **base, "form_id": form.id, "worker_id": worker.id,
            "workflow_status": "submitted", "department_id": supervisor.department_id,
            "date_from": "2026-09-15", "date_to": "2026-09-15",
        }
        for extension in ("html", "pdf"):
            status, body = asyncio.run(request(f"/supervisor/form-submissions/export.{extension}", combined))
            content = (
                "\n".join(page.extract_text() or "" for page in PdfReader(BytesIO(body)).pages)
                if extension == "pdf" else body.decode()
            )
            assert status == 200 and "needle target" in content, extension
            assert not any(marker in content for marker in ("needle other", "needle foreign", "needle retained")), extension
        for extension in ("csv", "html", "pdf"):
            status, _ = asyncio.run(request(f"/supervisor/form-submissions/export.{extension}", {**base, "department_id": foreign_department.id}))
            assert status == 404, (extension, status)
        supervisor.is_global_admin = True
        session.add(supervisor)
        session.commit()
        for department_id, expected in ((supervisor.department_id, expected_all), (foreign_department.id, {foreign["id"]}), (None, expected_all | {foreign["id"]})):
            params = {**base, **({"department_id": department_id} if department_id else {})}
            status, body = asyncio.run(request("/supervisor/form-submissions/export.csv", params))
            assert status == 200 and {int(row["id"]) for row in csv.DictReader(StringIO(body.decode()))} == expected, department_id
    print("ok - Report exports preserve structured filters, Department authority, global focus, and Daywork isolation")


def test_find_normalization_and_literal_characters():
    with report_fixture() as (session, _, worker, form):
        literal = submit(session, worker, form, "Literal 50%_ready\\path checked")
        other = submit(session, worker, form, "Other readiness")
        both = {literal["id"], other["id"]}
        for term, expected in (
            ("%", {literal["id"]}), ("_", {literal["id"]}), ("\\", {literal["id"]}),
            ("  LiTeRaL \t 50%_ready  ", {literal["id"]}),
            (worker.name, both), (worker.email, both), (form.name, both), ("   \t", both),
            ("No matching Report", set()), ("x" * 160, set()),
        ):
            params = {"purpose": "report", "search": term}
            status, body = asyncio.run(request("/supervisor/review-queue", {**params, "kind": "form"}))
            assert status == 200 and {item["id"] for item in json.loads(body)["items"]} == expected, term
            status, body = asyncio.run(request("/supervisor/form-submissions/export.csv", params))
            assert status == 200 and {int(row["id"]) for row in csv.DictReader(StringIO(body.decode()))} == expected, term
        for extension in ("csv", "html", "pdf"):
            status, body = asyncio.run(request(f"/supervisor/form-submissions/export.{extension}", {"purpose": "report", "search": "x" * 161}))
            assert status == 400 and json.loads(body)["detail"] == "search must be 160 characters or fewer", extension
        for extension in ("html", "pdf"):
            status, body = asyncio.run(request(f"/supervisor/form-submissions/export.{extension}", {"purpose": "report", "search": "No matching Report"}))
            content = (
                "\n".join(page.extract_text() or "" for page in PdfReader(BytesIO(body)).pages)
                if extension == "pdf" else body.decode()
            )
            assert status == 200 and "No Reports found" in content and "Other readiness" not in content, extension
    print("ok - Find shares case/whitespace normalization, literal wildcards, searchable fields, length validation, and empty results")


if __name__ == "__main__":
    test_csv_find_matches_inbox()
    test_document_find_matches_inbox()
    test_exports_include_all_matching_pages()
    test_export_filter_and_department_boundaries()
    test_find_normalization_and_literal_characters()
