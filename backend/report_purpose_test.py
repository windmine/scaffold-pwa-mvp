import csv
import sys
from io import BytesIO, StringIO
from pathlib import Path

from fastapi import HTTPException
from pypdf import PdfReader
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine


sys.path.insert(0, str(Path(__file__).resolve().parent))

from app.main import decide_record, decide_review_record  # noqa: E402
from app.models import Department, User, WorkForm  # noqa: E402
from app.schemas import (  # noqa: E402
    ApprovalRequest,
    ReportTransitionRequest,
    SupervisorWorkFormSubmissionCreate,
    SupervisorWorkFormSubmissionUpdate,
    WorkFormCreate,
    WorkFormField,
    WorkFormSubmissionCreate,
)
from app.use_cases.work_forms import (  # noqa: E402
    create_work_form,
    create_work_form_submission,
    list_my_form_submissions,
    list_supervisor_form_submissions,
    list_work_forms,
    transition_report,
)
from app.use_cases.review_queue import list_review_record_page  # noqa: E402
from app.use_cases.supervisor_review import (  # noqa: E402
    create_supervisor_work_form_submission,
    export_form_submission_csv,
    export_form_submission_html,
    export_form_submission_pdf,
    export_form_submissions_csv,
    export_form_submissions_html,
    export_form_submissions_pdf,
    update_supervisor_form_submission,
)


def make_session():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    session = Session(engine)
    department = Department(name="Report Purpose Department")
    session.add(department)
    session.flush()
    supervisor = User(
        department_id=department.id,
        email="purpose-supervisor@example.com",
        name="Purpose Supervisor",
        password_hash="test",
        role="supervisor",
    )
    session.add(supervisor)
    session.commit()
    session.refresh(supervisor)
    return engine, session, supervisor


def assert_http_error(label, status_code, callback):
    try:
        callback()
    except HTTPException as error:
        if error.status_code != status_code:
            raise AssertionError(
                f"{label}: expected {status_code}, got {error.status_code}"
            ) from error
        return error
    raise AssertionError(f"{label}: expected HTTP {status_code}")


def test_supervisor_created_template_defaults_to_report():
    engine, session, supervisor = make_session()
    try:
        created = create_work_form(
            WorkFormCreate(
                name="PPE Issue",
                fields=[
                    WorkFormField(
                        id="issue",
                        label="Issue",
                        type="text",
                        required=True,
                    )
                ],
            ),
            supervisor,
            session,
        )
        if created["template_purpose"] != "report":
            raise AssertionError("new Supervisor template must default to report")
    finally:
        session.close()
        engine.dispose()

    print("ok - Supervisor-created templates default to report")


def test_template_list_filters_report_from_daywork():
    engine, session, supervisor = make_session()
    try:
        session.add(WorkForm(
            department_id=supervisor.department_id,
            name="PPE Report",
            fields_json="[]",
            template_purpose="report",
            created_by=supervisor.id,
        ))
        session.add(WorkForm(
            department_id=supervisor.department_id,
            name="Daywork log form",
            fields_json="[]",
            template_purpose="daywork",
            created_by=supervisor.id,
        ))
        session.commit()

        reports = list_work_forms(supervisor, session, purpose="report")
        daywork = list_work_forms(supervisor, session, purpose="daywork")
        if [item["name"] for item in reports] != ["PPE Report"]:
            raise AssertionError(f"report template filter leaked Daywork: {reports}")
        if [item["name"] for item in daywork] != ["Daywork log form"]:
            raise AssertionError(f"daywork template filter leaked Reports: {daywork}")
    finally:
        session.close()
        engine.dispose()

    print("ok - Report Template list separates Daywork")


def test_worker_submission_copies_durable_template_purpose():
    engine, session, supervisor = make_session()
    try:
        worker = User(
            department_id=supervisor.department_id,
            email="purpose-worker@example.com",
            name="Purpose Worker",
            password_hash="test",
            role="worker",
            worker_class="leader",
        )
        daywork = WorkForm(
            department_id=supervisor.department_id,
            name="Daywork log form",
            fields_json="[]",
            template_purpose="daywork",
            created_by=supervisor.id,
        )
        session.add(worker)
        session.add(daywork)
        session.commit()
        session.refresh(worker)
        session.refresh(daywork)

        created = create_work_form_submission(
            WorkFormSubmissionCreate(
                form_id=daywork.id,
                work_date="2026-09-01",
                answers={},
            ),
            worker,
            session,
        )
        if created["submission_purpose"] != "daywork":
            raise AssertionError("submission must durably copy its template purpose")
    finally:
        session.close()
        engine.dispose()

    print("ok - submission durably copies template purpose")


def test_report_date_is_required_only_for_reports():
    engine, session, supervisor = make_session()
    try:
        worker = User(
            department_id=supervisor.department_id,
            email="date-worker@example.com",
            name="Date Worker",
            password_hash="test",
            role="worker",
            worker_class="leader",
        )
        report_form = WorkForm(
            department_id=supervisor.department_id,
            name="PPE Report",
            fields_json="[]",
            template_purpose="report",
        )
        daywork_form = WorkForm(
            department_id=supervisor.department_id,
            name="Daywork log form",
            fields_json="[]",
            template_purpose="daywork",
        )
        session.add(worker)
        session.add(report_form)
        session.add(daywork_form)
        session.commit()
        for item in (worker, report_form, daywork_form):
            session.refresh(item)

        assert_http_error(
            "Report Date remains required for Reports",
            400,
            lambda: create_work_form_submission(
                WorkFormSubmissionCreate(form_id=report_form.id, answers={}),
                worker,
                session,
            ),
        )
        daywork = create_work_form_submission(
            WorkFormSubmissionCreate(form_id=daywork_form.id, answers={}),
            worker,
            session,
        )
        if daywork["work_date"] is not None:
            raise AssertionError("legacy Daywork without a top-level work date changed")
        if daywork["submission_purpose"] != "daywork":
            raise AssertionError("date compatibility changed Daywork purpose")
    finally:
        session.close()
        engine.dispose()

    print("ok - Report Date is required only for Reports")


def test_worker_capability_separates_reports_from_legacy_daywork():
    engine, session, supervisor = make_session()
    try:
        normal_worker = User(
            department_id=supervisor.department_id,
            email="normal-capability-worker@example.com",
            name="Normal Capability Worker",
            password_hash="test",
            role="worker",
            worker_class="normal",
        )
        leader = User(
            department_id=supervisor.department_id,
            email="leader-capability-worker@example.com",
            name="Leader Capability Worker",
            password_hash="test",
            role="worker",
            worker_class="leader",
        )
        report_form = WorkForm(
            department_id=supervisor.department_id,
            name="PPE Report",
            fields_json="[]",
            template_purpose="report",
        )
        daywork_form = WorkForm(
            department_id=supervisor.department_id,
            name="Daywork log form",
            fields_json="[]",
            template_purpose="daywork",
        )
        session.add(normal_worker)
        session.add(leader)
        session.add(report_form)
        session.add(daywork_form)
        session.commit()
        for item in (normal_worker, leader, report_form, daywork_form):
            session.refresh(item)

        normal_unfiltered = list_work_forms(normal_worker, session)
        normal_reports = list_work_forms(normal_worker, session, purpose="report")
        normal_daywork = list_work_forms(normal_worker, session, purpose="daywork")
        leader_daywork = list_work_forms(leader, session, purpose="daywork")
        if [item["name"] for item in normal_unfiltered] != ["PPE Report"]:
            raise AssertionError("normal Worker unfiltered list exposed legacy Daywork")
        if [item["name"] for item in normal_reports] != ["PPE Report"]:
            raise AssertionError("normal Worker could not list Report Templates")
        if normal_daywork:
            raise AssertionError("normal Worker purpose filter exposed legacy Daywork")
        if [item["name"] for item in leader_daywork] != ["Daywork log form"]:
            raise AssertionError("Leader lost the retained Daywork Template")

        report = create_work_form_submission(
            WorkFormSubmissionCreate(
                form_id=report_form.id,
                work_date="2026-09-01",
                answers={},
            ),
            normal_worker,
            session,
        )
        if report["submission_purpose"] != "report":
            raise AssertionError("normal Worker Report submission was not retained")
        assert_http_error(
            "normal Worker cannot submit legacy Daywork",
            403,
            lambda: create_work_form_submission(
                WorkFormSubmissionCreate(form_id=daywork_form.id, answers={}),
                normal_worker,
                session,
            ),
        )
        daywork = create_work_form_submission(
            WorkFormSubmissionCreate(form_id=daywork_form.id, answers={}),
            leader,
            session,
        )
        if daywork["submission_purpose"] != "daywork":
            raise AssertionError("Leader lost retained Daywork submission")
    finally:
        session.close()
        engine.dispose()

    print("ok - every Worker can report while Daywork remains Leader-only")


def test_my_reports_filter_excludes_daywork():
    engine, session, supervisor = make_session()
    try:
        worker = User(
            department_id=supervisor.department_id,
            email="filtered-worker@example.com",
            name="Filtered Worker",
            password_hash="test",
            role="worker",
            worker_class="leader",
        )
        report_form = WorkForm(
            department_id=supervisor.department_id,
            name="PPE Report",
            fields_json="[]",
            template_purpose="report",
        )
        daywork_form = WorkForm(
            department_id=supervisor.department_id,
            name="Daywork log form",
            fields_json="[]",
            template_purpose="daywork",
        )
        session.add(worker)
        session.add(report_form)
        session.add(daywork_form)
        session.commit()
        for item in (worker, report_form, daywork_form):
            session.refresh(item)
        for form, key in ((report_form, "report-key"), (daywork_form, "daywork-key")):
            create_work_form_submission(
                WorkFormSubmissionCreate(
                    form_id=form.id,
                    work_date="2026-09-01",
                    answers={},
                    client_submission_id=key,
                ),
                worker,
                session,
            )

        reports = list_my_form_submissions(worker, session, purpose="report")
        retained = list_my_form_submissions(worker, session)
        if [item["form_name"] for item in reports] != ["PPE Report"]:
            raise AssertionError(f"My Reports filter leaked Daywork: {reports}")
        if {item["submission_purpose"] for item in retained} != {"report", "daywork"}:
            raise AssertionError("retained My submissions mode must preserve both purposes")
    finally:
        session.close()
        engine.dispose()

    print("ok - My Reports filter excludes Daywork and retained mode stays compatible")


def test_supervisor_report_queue_filter_excludes_daywork():
    engine, session, supervisor = make_session()
    try:
        worker = User(
            department_id=supervisor.department_id,
            email="queue-worker@example.com",
            name="Queue Worker",
            password_hash="test",
            role="worker",
            worker_class="leader",
        )
        report_form = WorkForm(
            department_id=supervisor.department_id,
            name="Incident Report",
            fields_json="[]",
            template_purpose="report",
        )
        daywork_form = WorkForm(
            department_id=supervisor.department_id,
            name="Daywork log form",
            fields_json="[]",
            template_purpose="daywork",
        )
        session.add(worker)
        session.add(report_form)
        session.add(daywork_form)
        session.commit()
        for item in (worker, report_form, daywork_form):
            session.refresh(item)
        for form, key in ((report_form, "queue-report"), (daywork_form, "queue-daywork")):
            create_work_form_submission(
                WorkFormSubmissionCreate(
                    form_id=form.id,
                    work_date="2026-09-01",
                    answers={},
                    client_submission_id=key,
                ),
                worker,
                session,
            )

        page = list_review_record_page(
            session,
            supervisor,
            kind="form",
            purpose="report",
        )
        if [item["form_name"] for item in page["items"]] != ["Incident Report"]:
            raise AssertionError(f"Reports queue leaked Daywork: {page['items']}")
        if page["items"][0]["submission_purpose"] != "report":
            raise AssertionError("Reports queue must expose durable submission purpose")
    finally:
        session.close()
        engine.dispose()

    print("ok - Supervisor Reports queue excludes Daywork")


def test_supervisor_submission_list_filter_excludes_daywork():
    engine, session, supervisor = make_session()
    try:
        worker = User(
            department_id=supervisor.department_id,
            email="list-worker@example.com",
            name="List Worker",
            password_hash="test",
            role="worker",
            worker_class="leader",
        )
        report_form = WorkForm(
            department_id=supervisor.department_id,
            name="Incident Report",
            fields_json="[]",
            template_purpose="report",
        )
        daywork_form = WorkForm(
            department_id=supervisor.department_id,
            name="Daywork log form",
            fields_json="[]",
            template_purpose="daywork",
        )
        session.add(worker)
        session.add(report_form)
        session.add(daywork_form)
        session.commit()
        for item in (worker, report_form, daywork_form):
            session.refresh(item)
        for form, key in ((report_form, "list-report"), (daywork_form, "list-daywork")):
            create_work_form_submission(
                WorkFormSubmissionCreate(
                    form_id=form.id,
                    work_date="2026-09-01",
                    answers={},
                    client_submission_id=key,
                ),
                worker,
                session,
            )

        reports = list_supervisor_form_submissions(
            None,
            supervisor,
            session,
            purpose="report",
        )
        if [item["form_name"] for item in reports] != ["Incident Report"]:
            raise AssertionError(f"Supervisor Report list leaked Daywork: {reports}")
    finally:
        session.close()
        engine.dispose()

    print("ok - Supervisor Report submission list excludes Daywork")


def test_report_transition_rejects_daywork_submission():
    engine, session, supervisor = make_session()
    try:
        worker = User(
            department_id=supervisor.department_id,
            email="transition-worker@example.com",
            name="Transition Worker",
            password_hash="test",
            role="worker",
            worker_class="leader",
        )
        form = WorkForm(
            department_id=supervisor.department_id,
            name="Daywork log form",
            fields_json="[]",
            template_purpose="daywork",
        )
        session.add(worker)
        session.add(form)
        session.commit()
        session.refresh(worker)
        session.refresh(form)
        daywork = create_work_form_submission(
            WorkFormSubmissionCreate(
                form_id=form.id,
                work_date="2026-09-01",
                answers={},
            ),
            worker,
            session,
        )

        error = assert_http_error(
            "Report transition rejects Daywork",
            400,
            lambda: transition_report(
                daywork["id"],
                ReportTransitionRequest(status="in_review"),
                supervisor,
                session,
            ),
        )
        if "not a Report" not in str(error.detail):
            raise AssertionError(f"unexpected transition error: {error.detail}")
    finally:
        session.close()
        engine.dispose()

    print("ok - Report transition rejects Daywork")


def test_legacy_decision_facades_reject_reports_but_retain_daywork():
    engine, session, supervisor = make_session()
    try:
        worker = User(
            department_id=supervisor.department_id,
            email="decision-worker@example.com",
            name="Decision Worker",
            password_hash="test",
            role="worker",
            worker_class="leader",
        )
        report_form = WorkForm(
            department_id=supervisor.department_id,
            name="Incident Report",
            fields_json="[]",
            template_purpose="report",
        )
        daywork_form = WorkForm(
            department_id=supervisor.department_id,
            name="Daywork log form",
            fields_json="[]",
            template_purpose="daywork",
        )
        session.add(worker)
        session.add(report_form)
        session.add(daywork_form)
        session.commit()
        for item in (worker, report_form, daywork_form):
            session.refresh(item)

        created = []
        for index, form in enumerate(
            (report_form, report_form, daywork_form, daywork_form),
            start=1,
        ):
            created.append(create_work_form_submission(
                WorkFormSubmissionCreate(
                    form_id=form.id,
                    work_date="2026-09-01",
                    answers={},
                    client_submission_id=f"decision-{index}",
                ),
                worker,
                session,
            ))

        assert_http_error(
            "typed legacy decision facade rejects Report",
            400,
            lambda: decide_review_record(
                "form",
                created[0]["id"],
                ApprovalRequest(status="approved"),
                supervisor,
                session,
            ),
        )
        assert_http_error(
            "compatibility legacy decision facade rejects Report",
            400,
            lambda: decide_record(
                created[1]["id"],
                ApprovalRequest(status="rejected", record_type="form"),
                supervisor,
                session,
            ),
        )

        approved = decide_review_record(
            "form",
            created[2]["id"],
            ApprovalRequest(status="approved"),
            supervisor,
            session,
        )
        rejected = decide_record(
            created[3]["id"],
            ApprovalRequest(status="rejected", record_type="form"),
            supervisor,
            session,
        )
        if approved["status"] != "approved" or rejected["status"] != "rejected":
            raise AssertionError("legacy Daywork approval behavior was not retained")
    finally:
        session.close()
        engine.dispose()

    print("ok - both legacy decision facades block Reports and retain Daywork")


def test_supervisor_manual_submission_rejects_report_but_retains_daywork():
    engine, session, supervisor = make_session()
    try:
        worker = User(
            department_id=supervisor.department_id,
            email="manual-worker@example.com",
            name="Manual Worker",
            password_hash="test",
            role="worker",
        )
        report_form = WorkForm(
            department_id=supervisor.department_id,
            name="PPE Report",
            fields_json="[]",
            template_purpose="report",
        )
        daywork_form = WorkForm(
            department_id=supervisor.department_id,
            name="Daywork log form",
            fields_json="[]",
            template_purpose="daywork",
        )
        session.add(worker)
        session.add(report_form)
        session.add(daywork_form)
        session.commit()
        for item in (worker, report_form, daywork_form):
            session.refresh(item)

        assert_http_error(
            "Supervisor manual create rejects Report Template",
            400,
            lambda: create_supervisor_work_form_submission(
                SupervisorWorkFormSubmissionCreate(
                    user_id=worker.id,
                    form_id=report_form.id,
                    work_date="2026-09-01",
                    answers={},
                    confirmed=True,
                ),
                supervisor,
                session,
            ),
        )
        daywork = create_supervisor_work_form_submission(
            SupervisorWorkFormSubmissionCreate(
                user_id=worker.id,
                form_id=daywork_form.id,
                work_date="2026-09-01",
                answers={},
                confirmed=True,
            ),
            supervisor,
            session,
        )
        if daywork["status"] != "approved":
            raise AssertionError("retained manual Daywork must remain approved")
        if daywork["submission_purpose"] != "daywork":
            raise AssertionError("manual Daywork must durably retain its purpose")
    finally:
        session.close()
        engine.dispose()

    print("ok - Supervisor manual creation blocks Reports and retains Daywork")


def test_supervisor_can_edit_retained_daywork_submission():
    engine, session, supervisor = make_session()
    try:
        worker = User(
            department_id=supervisor.department_id,
            email="editable-daywork-worker@example.com",
            name="Editable Daywork Worker",
            password_hash="test",
            role="worker",
            worker_class="leader",
        )
        form = WorkForm(
            department_id=supervisor.department_id,
            name="Daywork log form",
            fields_json=(
                '[{"id":"work","label":"Work","type":"text",'
                '"required":true,"options":[]}]'
            ),
            template_purpose="daywork",
        )
        session.add(worker)
        session.add(form)
        session.commit()
        session.refresh(worker)
        session.refresh(form)
        daywork = create_work_form_submission(
            WorkFormSubmissionCreate(
                form_id=form.id,
                work_date="2026-09-01",
                answers={"work": "Original work"},
            ),
            worker,
            session,
        )

        updated = update_supervisor_form_submission(
            daywork["id"],
            SupervisorWorkFormSubmissionUpdate(
                work_date="2026-09-02",
                answers={"work": "Corrected work"},
                confirmed=True,
            ),
            supervisor,
            session,
        )
        if updated["work_date"] != "2026-09-02":
            raise AssertionError("Supervisor Daywork edit did not update the work date")
        if updated["answers"] != {"work": "Corrected work"}:
            raise AssertionError("Supervisor Daywork edit did not update answers")
        if updated["submission_purpose"] != "daywork":
            raise AssertionError("Supervisor Daywork edit changed durable purpose")
    finally:
        session.close()
        engine.dispose()

    print("ok - retained Daywork submissions remain editable by Supervisors")


def test_collection_csv_export_filters_reports_from_daywork():
    engine, session, supervisor = make_session()
    try:
        worker = User(
            department_id=supervisor.department_id,
            email="export-worker@example.com",
            name="Export Worker",
            password_hash="test",
            role="worker",
            worker_class="leader",
        )
        report_form = WorkForm(
            department_id=supervisor.department_id,
            name="PPE Report",
            fields_json="[]",
            template_purpose="report",
        )
        daywork_form = WorkForm(
            department_id=supervisor.department_id,
            name="Daywork log form",
            fields_json="[]",
            template_purpose="daywork",
        )
        session.add(worker)
        session.add(report_form)
        session.add(daywork_form)
        session.commit()
        for item in (worker, report_form, daywork_form):
            session.refresh(item)
        for form, key in ((report_form, "export-report"), (daywork_form, "export-daywork")):
            create_work_form_submission(
                WorkFormSubmissionCreate(
                    form_id=form.id,
                    work_date="2026-09-01",
                    answers={},
                    client_submission_id=key,
                ),
                worker,
                session,
            )

        response = export_form_submissions_csv(
            session,
            supervisor,
            purpose="report",
        )
        body = response.body.decode("utf-8")
        if "PPE Report" not in body or "Daywork log form" in body:
            raise AssertionError(f"report-only CSV export leaked Daywork: {body}")
    finally:
        session.close()
        engine.dispose()

    print("ok - collection CSV export filters Reports from Daywork")


def test_report_csv_exports_workflow_lifecycle_details():
    engine, session, supervisor = make_session()
    try:
        worker = User(
            department_id=supervisor.department_id,
            email="lifecycle-export-worker@example.com",
            name="Lifecycle Export Worker",
            password_hash="test",
            role="worker",
        )
        form = WorkForm(
            department_id=supervisor.department_id,
            name="PPE Report",
            fields_json="[]",
            template_purpose="report",
        )
        session.add(worker)
        session.add(form)
        session.commit()
        session.refresh(worker)
        session.refresh(form)
        report = create_work_form_submission(
            WorkFormSubmissionCreate(
                form_id=form.id,
                work_date="2026-09-01",
                answers={},
            ),
            worker,
            session,
        )
        transition_report(
            report["id"],
            ReportTransitionRequest(status="in_review"),
            supervisor,
            session,
        )
        transition_report(
            report["id"],
            ReportTransitionRequest(
                status="resolved",
                supervisor_note="Replacement helmet issued",
            ),
            supervisor,
            session,
        )

        response = export_form_submission_csv(report["id"], session, supervisor)
        row = next(csv.DictReader(StringIO(response.body.decode("utf-8-sig"))))
        expected = {
            "status": "resolved",
            "workflow_status": "resolved",
            "supervisor_note": "Replacement helmet issued",
            "reviewing_supervisor_id": str(supervisor.id),
            "reviewing_supervisor_name": supervisor.name,
        }
        for key, value in expected.items():
            if row.get(key) != value:
                raise AssertionError(
                    f"Report CSV {key}: expected {value!r}, got {row.get(key)!r}"
                )
        if not row.get("review_started_at") or not row.get("resolved_at"):
            raise AssertionError("Report CSV must include both lifecycle timestamps")
    finally:
        session.close()
        engine.dispose()

    print("ok - Report CSV exports workflow lifecycle details")


def test_report_html_exports_workflow_lifecycle_details():
    engine, session, supervisor = make_session()
    try:
        worker = User(
            department_id=supervisor.department_id,
            email="html-export-worker@example.com",
            name="HTML Export Worker",
            password_hash="test",
            role="worker",
        )
        form = WorkForm(
            department_id=supervisor.department_id,
            name="Incident Report",
            fields_json="[]",
            template_purpose="report",
        )
        session.add(worker)
        session.add(form)
        session.commit()
        session.refresh(worker)
        session.refresh(form)
        report = create_work_form_submission(
            WorkFormSubmissionCreate(
                form_id=form.id,
                work_date="2026-09-01",
                answers={},
            ),
            worker,
            session,
        )
        transition_report(
            report["id"],
            ReportTransitionRequest(status="in_review"),
            supervisor,
            session,
        )
        transition_report(
            report["id"],
            ReportTransitionRequest(
                status="resolved",
                supervisor_note="Guard rail replaced",
            ),
            supervisor,
            session,
        )

        response = export_form_submission_html(report["id"], session, supervisor)
        body = response.body.decode("utf-8")
        for expected in (
            "Status",
            "resolved",
            "Supervisor note",
            "Guard rail replaced",
            "Reviewing Supervisor",
            supervisor.name,
            "Review started",
            "Resolved",
        ):
            if expected not in body:
                raise AssertionError(f"Report HTML missing lifecycle detail {expected!r}")
        if "pending" in body:
            raise AssertionError("Report HTML must not display legacy pending as its status")
    finally:
        session.close()
        engine.dispose()

    print("ok - Report HTML exports workflow lifecycle details")


def test_report_pdf_exports_workflow_lifecycle_details():
    engine, session, supervisor = make_session()
    try:
        worker = User(
            department_id=supervisor.department_id,
            email="pdf-export-worker@example.com",
            name="PDF Export Worker",
            password_hash="test",
            role="worker",
        )
        form = WorkForm(
            department_id=supervisor.department_id,
            name="Safety Report",
            fields_json="[]",
            template_purpose="report",
        )
        session.add(worker)
        session.add(form)
        session.commit()
        session.refresh(worker)
        session.refresh(form)
        report = create_work_form_submission(
            WorkFormSubmissionCreate(
                form_id=form.id,
                work_date="2026-09-01",
                answers={},
            ),
            worker,
            session,
        )
        transition_report(
            report["id"],
            ReportTransitionRequest(status="in_review"),
            supervisor,
            session,
        )
        transition_report(
            report["id"],
            ReportTransitionRequest(
                status="resolved",
                supervisor_note="Safe access restored",
            ),
            supervisor,
            session,
        )

        response = export_form_submission_pdf(
            report["id"],
            session,
            supervisor,
        )
        text = "\n".join(
            page.extract_text() or ""
            for page in PdfReader(BytesIO(response.body)).pages
        )
        for expected in (
            "STATUS",
            "resolved",
            "Report review",
            "SUPERVISOR NOTE",
            "Safe access restored",
            "REVIEWING",
            supervisor.name,
            "REVIEW STARTED",
            "RESOLVED",
        ):
            if expected not in text:
                raise AssertionError(
                    f"Report PDF missing lifecycle detail {expected!r}: {text!r}"
                )
        if "pending" in text:
            raise AssertionError("Report PDF must not display legacy pending as its status")
    finally:
        session.close()
        engine.dispose()

    print("ok - Report PDF exports workflow lifecycle details")


def test_collection_document_exports_filter_reports_from_daywork():
    engine, session, supervisor = make_session()
    try:
        worker = User(
            department_id=supervisor.department_id,
            email="document-filter-worker@example.com",
            name="Document Filter Worker",
            password_hash="test",
            role="worker",
            worker_class="leader",
        )
        report_form = WorkForm(
            department_id=supervisor.department_id,
            name="Incident Report",
            fields_json="[]",
            template_purpose="report",
        )
        daywork_form = WorkForm(
            department_id=supervisor.department_id,
            name="Daywork log form",
            fields_json="[]",
            template_purpose="daywork",
        )
        session.add(worker)
        session.add(report_form)
        session.add(daywork_form)
        session.commit()
        for item in (worker, report_form, daywork_form):
            session.refresh(item)
        for form, key in ((report_form, "document-report"), (daywork_form, "document-daywork")):
            create_work_form_submission(
                WorkFormSubmissionCreate(
                    form_id=form.id,
                    work_date="2026-09-01",
                    answers={},
                    client_submission_id=key,
                ),
                worker,
                session,
            )

        html_response = export_form_submissions_html(
            session,
            supervisor,
            purpose="report",
        )
        html_body = html_response.body.decode("utf-8")
        pdf_response = export_form_submissions_pdf(
            session,
            supervisor,
            purpose="report",
        )
        pdf_text = "\n".join(
            page.extract_text() or ""
            for page in PdfReader(BytesIO(pdf_response.body)).pages
        )
        for label, content in (("HTML", html_body), ("PDF", pdf_text)):
            if "Incident Report" not in content or "Daywork log form" in content:
                raise AssertionError(
                    f"report-only {label} collection export leaked Daywork: {content}"
                )
    finally:
        session.close()
        engine.dispose()

    print("ok - collection HTML/PDF exports filter Reports from Daywork")


def test_daywork_exports_use_durable_purpose_after_template_rename():
    engine, session, supervisor = make_session()
    try:
        leader = User(
            department_id=supervisor.department_id,
            email="renamed-daywork-leader@example.com",
            name="Renamed Daywork Leader",
            password_hash="test",
            role="worker",
            worker_class="leader",
        )
        form = WorkForm(
            department_id=supervisor.department_id,
            name="Legacy labour sheet",
            fields_json="[]",
            template_purpose="daywork",
        )
        session.add(leader)
        session.add(form)
        session.commit()
        session.refresh(leader)
        session.refresh(form)
        daywork = create_work_form_submission(
            WorkFormSubmissionCreate(form_id=form.id, answers={}),
            leader,
            session,
        )

        csv_response = export_form_submission_csv(daywork["id"], session, supervisor)
        html_response = export_form_submission_html(daywork["id"], session, supervisor)
        pdf_response = export_form_submission_pdf(daywork["id"], session, supervisor)
        expected_prefix = f"daywork-submission-{daywork['id']}"
        for suffix, response in (
            ("csv", csv_response),
            ("html", html_response),
            ("pdf", pdf_response),
        ):
            disposition = response.headers.get("content-disposition", "")
            if f'{expected_prefix}.{suffix}' not in disposition:
                raise AssertionError(
                    f"renamed Daywork {suffix.upper()} received Report filename: "
                    f"{disposition}"
                )
        html_body = html_response.body.decode("utf-8")
        for expected in ("Work date", "Submission", "Daywork details"):
            if expected not in html_body:
                raise AssertionError(
                    f"renamed Daywork HTML missing retained label {expected!r}"
                )
        for forbidden in ("Report Date", "Report answers", "Report #"):
            if forbidden in html_body:
                raise AssertionError(
                    f"renamed Daywork HTML was relabelled as Report: {forbidden}"
                )
        if pdf_response.media_type != "application/pdf":
            raise AssertionError("renamed Daywork did not retain its PDF export")
    finally:
        session.close()
        engine.dispose()

    print("ok - Daywork exports follow durable purpose after a Template rename")


def test_daywork_collection_exports_keep_retained_labels_and_filenames():
    engine, session, supervisor = make_session()
    try:
        leader = User(
            department_id=supervisor.department_id,
            email="daywork-collection-leader@example.com",
            name="Daywork Collection Leader",
            password_hash="test",
            role="worker",
            worker_class="leader",
        )
        form = WorkForm(
            department_id=supervisor.department_id,
            name="Legacy labour sheet",
            fields_json="[]",
            template_purpose="daywork",
        )
        session.add(leader)
        session.add(form)
        session.commit()
        session.refresh(leader)
        session.refresh(form)
        create_work_form_submission(
            WorkFormSubmissionCreate(form_id=form.id, answers={}),
            leader,
            session,
        )

        csv_response = export_form_submissions_csv(
            session,
            supervisor,
            purpose="daywork",
        )
        html_response = export_form_submissions_html(
            session,
            supervisor,
            purpose="daywork",
        )
        pdf_response = export_form_submissions_pdf(
            session,
            supervisor,
            purpose="daywork",
        )
        for suffix, response in (
            ("csv", csv_response),
            ("html", html_response),
            ("pdf", pdf_response),
        ):
            disposition = response.headers.get("content-disposition", "")
            if f"daywork-submissions.{suffix}" not in disposition:
                raise AssertionError(
                    f"Daywork collection {suffix.upper()} received Report filename: "
                    f"{disposition}"
                )
        html_body = html_response.body.decode("utf-8")
        if "Daywork Export" not in html_body or "Report Export" in html_body:
            raise AssertionError("Daywork HTML collection was relabelled as Reports")
        pdf_text = "\n".join(
            page.extract_text() or ""
            for page in PdfReader(BytesIO(pdf_response.body)).pages
        )
        if "General Daywork Form" not in pdf_text:
            raise AssertionError("Daywork PDF collection lost its retained layout")
    finally:
        session.close()
        engine.dispose()

    print("ok - Daywork collection exports retain labels and filenames")


def main():
    test_supervisor_created_template_defaults_to_report()
    test_template_list_filters_report_from_daywork()
    test_worker_submission_copies_durable_template_purpose()
    test_report_date_is_required_only_for_reports()
    test_worker_capability_separates_reports_from_legacy_daywork()
    test_my_reports_filter_excludes_daywork()
    test_supervisor_report_queue_filter_excludes_daywork()
    test_supervisor_submission_list_filter_excludes_daywork()
    test_report_transition_rejects_daywork_submission()
    test_legacy_decision_facades_reject_reports_but_retain_daywork()
    test_supervisor_manual_submission_rejects_report_but_retains_daywork()
    test_supervisor_can_edit_retained_daywork_submission()
    test_collection_csv_export_filters_reports_from_daywork()
    test_report_csv_exports_workflow_lifecycle_details()
    test_report_html_exports_workflow_lifecycle_details()
    test_report_pdf_exports_workflow_lifecycle_details()
    test_collection_document_exports_filter_reports_from_daywork()
    test_daywork_exports_use_durable_purpose_after_template_rename()
    test_daywork_collection_exports_keep_retained_labels_and_filenames()
    print("report purpose test passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
