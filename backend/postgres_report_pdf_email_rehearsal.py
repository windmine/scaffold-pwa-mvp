"""PDF outbox races on the runner's owned native PostgreSQL databases only."""
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier, Event
from unittest.mock import patch

from sqlmodel import Session, select
from app import email_transport
from app.migrations import run_migrations
from app.models import ReportPdfEmail, User, WorkFormSubmission
from app.schemas import UserUpdateRequest, WorkFormEmailSettings, WorkFormSubmissionCreate
from app.use_cases import report_pdf_email as delivery
from app.use_cases.work_forms import create_work_form_submission
from postgres_invitation_rehearsal import overlapping_operations, seed_supervisors
from postgres_template_edit_rehearsal import seed_template
from postgres_review_rehearsal import is_statement, require


def run_pdf_email_checks(database, report):
    from report_pdf_email_migration_checks import check_additive_migration
    with database("report_pdf_email_upgrade") as engine:
        check_additive_migration(engine)
        report("PostgreSQL 0023-to-current upgrade preserves existing Report data and all prior checksums; routing off, no outbox backfill")
    with database("report_pdf_email") as engine:
        run_migrations(engine)
        with Session(engine) as session:
            require(session.exec(select(ReportPdfEmail)).all() == [], "Migration queued historical Reports")
        supervisors = seed_supervisors(engine)
        template, worker_id, original = seed_template(engine, supervisors[0], "pdf-outbox")
        form_id = template["id"]
        with Session(engine) as session:
            session.add_all([User(department_id=1, name=address, email=address, password_hash="not-a-login")
                             for address in ("first@example.invalid", "next@example.invalid")])
            session.commit()
        def settings(session, recipient="first@example.invalid", version=1):
            return delivery.update_email_settings(form_id, WorkFormEmailSettings(enabled=True,
                recipient=recipient, expected_version=version, confirmed=True), session.get(User, supervisors[0]), session)
        def submit(session, key):
            return create_work_form_submission(WorkFormSubmissionCreate(form_id=form_id,
                expected_definition_version=1, work_date="2026-10-21", answers={"note": "Committed Report"},
                client_submission_id=key), session.get(User, worker_id), session, include_replay_marker=True)
        with Session(engine) as session:
            # seed_template submits one new Report through the real API. It now
            # correctly captures its submitter copy even with template routing off.
            initial = session.exec(select(ReportPdfEmail)).all()
            require(len(initial) == 1 and initial[0].submission_id == original["id"]
                    and initial[0].recipient_role == "submitter", "Seed Report did not capture its own copy")
            settings(session)
            require([row.id for row in session.exec(select(ReportPdfEmail)).all()] == [row.id for row in initial],
                    "Enabling queued historical Reports")
        report("PostgreSQL extra routing defaults off; new Reports capture submitter copies and enabling never queues existing Reports")

        barrier = Barrier(2, timeout=10)
        def simultaneous_submit(_):
            with Session(engine) as session:
                barrier.wait()
                return submit(session, "concurrent-offline-replay")
        with ThreadPoolExecutor(max_workers=2) as pool:
            rows = list(pool.map(simultaneous_submit, range(2)))
        require(rows[0]["id"] == rows[1]["id"] and sum(row["idempotent_replay"] for row in rows) == 1,
                "Concurrent offline replay did not converge to one Report")
        with Session(engine) as session:
            outbox = session.exec(select(ReportPdfEmail).where(ReportPdfEmail.submission_id != original["id"])).all()
            require(len(outbox) == 2 and {row.recipient_role for row in outbox} == {"submitter", "template"},
                    "Concurrent replay did not preserve exactly one row per recipient")
            require(all(row.submission_id == rows[0]["id"] for row in outbox), "Outbox not atomic with winning Report")
            require(len({row.recipient_key for row in outbox}) == 2, "Duplicate normalized recipient")
            outbox_id = next(row.id for row in outbox if row.recipient_role == "template")
        report("PostgreSQL simultaneous offline POSTs commit one Report and one outbox row for each distinct recipient")

        outcomes, _proof = overlapping_operations(engine, "workform", {
            "settings": lambda session: settings(session, "next@example.invalid", 2),
            "submit": lambda session: submit(session, "routing-race"),
        }, "settings")
        require(all(value["status"] == 200 for value in outcomes.values()), "Routing/submission contention failed")
        with Session(engine) as session:
            pending = session.exec(select(ReportPdfEmail).where(ReportPdfEmail.submission_id != original["id"]).order_by(ReportPdfEmail.id)).all()
            require([row.recipient for row in pending if row.recipient_role == "template"] == ["first@example.invalid", "next@example.invalid"],
                    "Routing race did not preserve old recipient and capture committed new recipient")
            require(len(pending) == 4 and sum(row.recipient_role == "submitter" for row in pending) == 2,
                    "Routing race lost or duplicated a submitter copy")
        report("PostgreSQL observed row-lock contention preserves submitted routing and captures new settings atomically")

        sending, release = Event(), Event()
        def fake_send(*_args, **_kwargs):
            sending.set()
            require(release.wait(10), "Test observer did not release mocked SMTP")
        with patch.object(email_transport, "send_email", side_effect=fake_send) as mocked:
            with ThreadPoolExecutor(max_workers=2) as pool:
                first = pool.submit(delivery.dispatch_one, engine, outbox_id)
                require(sending.wait(10), "Claim did not reach mocked SMTP")
                try:
                    second = pool.submit(delivery.dispatch_one, engine, outbox_id)
                    require(second.result(timeout=10) == "skipped", "Concurrent worker repeated a claimed send")
                    with Session(engine) as session:
                        require(session.get(ReportPdfEmail, outbox_id).status == "uncertain", "SMTP started before durable claim")
                finally:
                    release.set()
                require(first.result(timeout=10) == "accepted", "Mocked SMTP result not saved")
            require(mocked.call_count == 1, "SMTP called more than once")
        report("PostgreSQL worker claim commits before SMTP; concurrent workers cannot repeat an in-flight send")

        with Session(engine) as session:
            second_id = session.exec(select(ReportPdfEmail.id).where(ReportPdfEmail.id != outbox_id, ReportPdfEmail.recipient_role == "template")).one()
        with patch.object(email_transport, "send_email", side_effect=email_transport.EmailSendError("unknown")) as mocked:
            require(delivery.dispatch_one(engine, second_id) == "uncertain", "Unknown acceptance was not retained")
            require(delivery.dispatch_one(engine, second_id) == "skipped", "Unknown acceptance retried")
            require(mocked.call_count == 1, "Unknown SMTP call repeated")
        with Session(engine) as session:
            require(session.get(WorkFormSubmission, original["id"]) is not None, "Original Report was changed")
        report("PostgreSQL uncertain SMTP acceptance never retries and committed Reports remain durable")

        with Session(engine) as session:
            submitter_ids = session.exec(select(ReportPdfEmail.id).where(ReportPdfEmail.recipient_role == "submitter", ReportPdfEmail.submission_id != original["id"])).all()
        with patch.object(email_transport, "send_email") as mocked:
            for row_id in submitter_ids:
                require(delivery.dispatch_one(engine, row_id) == "accepted", "Separate submitter copy failed")
                require(delivery.dispatch_one(engine, row_id) == "skipped", "Submitter copy repeated")
            require(mocked.call_count == 2, "Distinct Reports did not retain independent submitter copies")
        report("PostgreSQL submitter copies dispatch independently of accepted/uncertain template copies without repeats")

    with database("report_pdf_department_recipients") as engine:
        run_migrations(engine)
        supervisors = seed_supervisors(engine)
        with Session(engine) as session:
            supervisor = session.get(User, supervisors[0])
            supervisor.is_global_admin = True
            session.add(supervisor)
            session.commit()
        for field, changed in (("status", "resigned"), ("department_id", 2), ("email", "changed@example.invalid")):
            for preferred in ("change", "submit"):
                check_recipient_change_race(engine, supervisors[0], field, changed, preferred, report)


def check_recipient_change_race(engine, supervisor_id, field, changed, preferred, report):
    """Observe actual PostgreSQL blocking for both orderings of each staff edit."""
    from app.use_cases.staff_site_admin import update_user
    label = f"recipient-{field}-{preferred}"
    template, worker_id, original = seed_template(engine, supervisor_id, label)
    address = f"{label}@example.invalid"
    # Email must remain unique across each owned race fixture.
    changed = f"changed-{label}@example.invalid" if field == "email" else changed
    with Session(engine) as session:
        recipient = User(department_id=1, email=address, name="Selected recipient", password_hash="not-a-login")
        session.add(recipient)
        session.commit()
        recipient_id = recipient.id

    def submit(session):
        return create_work_form_submission(WorkFormSubmissionCreate(
            form_id=template["id"], expected_definition_version=1, work_date="2026-11-10",
            answers={"note": "Recipient locking fixture"}, client_submission_id=label,
            pdf_email_recipients=[address], pdf_email_recipient_users=[{"user_id": recipient_id, "email": address}],
            expected_pdf_email_version=template["pdf_email_options"]["version"],
        ), session.get(User, worker_id), session)

    def claim_statement(context):
        statement = getattr(getattr(context, "compiled", None), "statement", None)
        return (is_statement(context, "update", "user") or
                (getattr(statement, "is_select", False) and getattr(statement, "_for_update_arg", None) is not None
                 and any(getattr(table, "name", None) == "user" for table in statement.get_final_froms())))

    outcomes, proof = overlapping_operations(engine, "user", {
        "change": lambda session: update_user(recipient_id, UserUpdateRequest(confirmed=True, **{field: changed}),
                                              session.get(User, supervisor_id), session),
        "submit": submit,
    }, preferred, claim_statement=claim_statement)
    expected_submit = 200 if preferred == "submit" else 409
    require(outcomes["change"]["status"] == 200 and outcomes["submit"]["status"] == expected_submit,
            "Recipient account edit and submit did not respect row-lock serialization")
    with Session(engine) as session:
        submissions = session.exec(select(WorkFormSubmission).where(WorkFormSubmission.client_submission_id == label)).all()
        require(len(submissions) == int(preferred == "submit"), "Rejected recipient selection committed a Report")
        rows = session.exec(select(ReportPdfEmail).where(ReportPdfEmail.submission_id.in_(
            select(WorkFormSubmission.id).where(WorkFormSubmission.form_id == template["id"],
                                              WorkFormSubmission.id != original["id"])
        ))).all()
        require(len(rows) == (2 if preferred == "submit" else 0), "Recipient race lost atomic Report/outbox state")
        if rows:
            require({row.recipient for row in rows} == {address, f"{label}@rehearsal.invalid"},
                    "Post-submit account change redirected the frozen recipient or submitter copy")
        require(getattr(session.get(User, recipient_id), field) == changed, "Staff edit was lost")
    report(f"PostgreSQL recipient {field} race ({preferred} first): observed blocking, current eligibility, atomic frozen recipients", proof)
