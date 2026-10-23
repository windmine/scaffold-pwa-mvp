"""PDF outbox races on the runner's owned native PostgreSQL databases only."""
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier, Event
from unittest.mock import patch

from sqlmodel import Session, select
from app import email_transport
from app.migrations import run_migrations
from app.models import ReportPdfEmail, User, WorkFormSubmission
from app.schemas import WorkFormEmailSettings, WorkFormSubmissionCreate
from app.use_cases import report_pdf_email as delivery
from app.use_cases.work_forms import create_work_form_submission
from postgres_invitation_rehearsal import overlapping_operations, seed_supervisors
from postgres_template_edit_rehearsal import seed_template
from postgres_review_rehearsal import require


def run_pdf_email_checks(database, report):
    from report_pdf_email_migration_checks import check_additive_migration
    with database("report_pdf_email_upgrade") as engine:
        check_additive_migration(engine)
        report("PostgreSQL 0023-to-current upgrade preserves existing Report data and all prior checksums; routing off, no outbox backfill")
    with database("report_pdf_email") as engine:
        run_migrations(engine)
        supervisors = seed_supervisors(engine)
        template, worker_id, original = seed_template(engine, supervisors[0], "pdf-outbox")
        form_id = template["id"]
        def settings(session, recipient="first@example.invalid", version=1):
            return delivery.update_email_settings(form_id, WorkFormEmailSettings(enabled=True,
                recipient=recipient, expected_version=version, confirmed=True), session.get(User, supervisors[0]), session)
        def submit(session, key):
            return create_work_form_submission(WorkFormSubmissionCreate(form_id=form_id,
                expected_definition_version=1, work_date="2026-10-21", answers={"note": "Committed Report"},
                client_submission_id=key), session.get(User, worker_id), session, include_replay_marker=True)
        with Session(engine) as session:
            require(session.exec(select(ReportPdfEmail)).all() == [], "Migration queued historical Reports")
            settings(session)
            require(session.exec(select(ReportPdfEmail)).all() == [], "Enabling queued historical Reports")
        report("PostgreSQL PDF email defaults off; migration and enabling never queue existing Reports")

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
            outbox = session.exec(select(ReportPdfEmail)).one()
            outbox_id = outbox.id
            require(outbox.submission_id == rows[0]["id"], "Outbox not atomic with winning Report")
        report("PostgreSQL simultaneous offline POSTs commit one Report and exactly one outbox row")

        outcomes, _proof = overlapping_operations(engine, "workform", {
            "settings": lambda session: settings(session, "next@example.invalid", 2),
            "submit": lambda session: submit(session, "routing-race"),
        }, "settings")
        require(all(value["status"] == 200 for value in outcomes.values()), "Routing/submission contention failed")
        with Session(engine) as session:
            pending = session.exec(select(ReportPdfEmail).order_by(ReportPdfEmail.id)).all()
            require([row.recipient for row in pending] == ["first@example.invalid", "next@example.invalid"],
                    "Routing race did not preserve old recipient and capture committed new recipient")
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
            second_id = session.exec(select(ReportPdfEmail.id).where(ReportPdfEmail.id != outbox_id)).one()
        with patch.object(email_transport, "send_email", side_effect=email_transport.EmailSendError("unknown")) as mocked:
            require(delivery.dispatch_one(engine, second_id) == "uncertain", "Unknown acceptance was not retained")
            require(delivery.dispatch_one(engine, second_id) == "skipped", "Unknown acceptance retried")
            require(mocked.call_count == 1, "Unknown SMTP call repeated")
        with Session(engine) as session:
            require(session.get(WorkFormSubmission, original["id"]) is not None, "Original Report was changed")
        report("PostgreSQL uncertain SMTP acceptance never retries and committed Reports remain durable")
