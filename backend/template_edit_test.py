"""Optimistic Template-edit regressions through public use-case interfaces."""
from contextlib import contextmanager
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
import time

from fastapi import HTTPException
from sqlmodel import Session, SQLModel, create_engine

sys.path.insert(0, str(Path(__file__).resolve().parent))

from app.models import Department, User  # noqa: E402
from app.schemas import WorkFormCreate, WorkFormField, WorkFormUpdate  # noqa: E402
from app.use_cases.audit import list_audit_events  # noqa: E402
from app.use_cases.work_forms import create_work_form, list_work_forms, update_work_form  # noqa: E402


@contextmanager
def template_database():
    with TemporaryDirectory(prefix="template-edit-test-") as directory:
        engine = create_engine(f"sqlite:///{Path(directory).as_posix()}/test.db", connect_args={"check_same_thread": False})
        SQLModel.metadata.create_all(engine)
        with Session(engine) as session:
            department = Department(name="Template Edit Department")
            session.add(department)
            session.flush()
            supervisor = User(name="Template Supervisor", email="template-editor@example.com", password_hash="test",
                              role="supervisor", department_id=department.id)
            session.add(supervisor)
            session.commit()
            supervisor_id = supervisor.id
        try:
            yield engine, supervisor_id
        finally:
            engine.dispose()


def new_template(supervisor, session):
    return create_work_form(WorkFormCreate(
        name="Original Template", description="Original description",
        fields=[WorkFormField(id="note", label="Note", type="text")],
    ), supervisor, session)


def test_stale_edit_preserves_newer_template_and_audit():
    with template_database() as (engine, supervisor_id), Session(engine) as session:
        supervisor = session.get(User, supervisor_id)
        original = new_template(supervisor, session)
        newer = update_work_form(original["id"], WorkFormUpdate(
            name="Newer Template", expected_definition_version=1, confirmed=True,
        ), supervisor, session)
        audit_before = list_audit_events(session, supervisor)
        try:
            update_work_form(original["id"], WorkFormUpdate(
                name="Stale Draft", description="Must not replace newer work",
                expected_definition_version=1, confirmed=True,
            ), supervisor, session)
        except HTTPException as error:
            assert error.status_code == 409
            assert error.detail["code"] == "report_template_edit_version_conflict"
            assert error.detail["expected_definition_version"] == 1
            assert error.detail["current_definition_version"] == 2
        else:
            raise AssertionError("A stale saved Template draft overwrote a newer Definition")
        assert list_work_forms(supervisor, session) == [newer]
        assert list_audit_events(session, supervisor) == audit_before
    print("ok - stale Template edits conflict without changing newer content or audit")


def test_current_noop_legacy_and_status_updates_preserve_version_semantics():
    with template_database() as (engine, supervisor_id), Session(engine) as session:
        supervisor = session.get(User, supervisor_id)
        original = new_template(supervisor, session)
        current = update_work_form(original["id"], WorkFormUpdate(
            name="Current Template", expected_definition_version=1, confirmed=True,
        ), supervisor, session)
        assert current["definition_version"] == 2
        unchanged = update_work_form(original["id"], WorkFormUpdate(
            name="Current Template", expected_definition_version=2, confirmed=True,
        ), supervisor, session)
        assert unchanged["definition_version"] == 2
        archived = update_work_form(original["id"], WorkFormUpdate(
            status="archived", expected_definition_version=1, confirmed=True,
        ), supervisor, session)
        assert archived["status"] == "archived" and archived["definition_version"] == 2
        legacy = update_work_form(original["id"], WorkFormUpdate(description="Legacy edit", confirmed=True), supervisor, session)
        assert legacy["definition_version"] == 3 and legacy["status"] == "archived"
        active = update_work_form(original["id"], WorkFormUpdate(status="active", confirmed=True), supervisor, session)
        assert active["definition_version"] == 3 and active["status"] == "active"
    print("ok - current, no-op, legacy and status-only edits preserve Definition version semantics")


def test_concurrent_precondition_edits_have_one_winner():
    with template_database() as (engine, supervisor_id):
        with Session(engine) as session:
            original = new_template(session.get(User, supervisor_id), session)
        barrier = Barrier(2)
        def edit(name):
            with Session(engine) as session:
                supervisor = session.get(User, supervisor_id)
                barrier.wait(timeout=5)
                try:
                    return 200, update_work_form(original["id"], WorkFormUpdate(
                        name=name, expected_definition_version=1, confirmed=True,
                    ), supervisor, session)
                except HTTPException as error:
                    return error.status_code, error.detail
        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(edit, ["First draft", "Second draft"]))
        assert sorted(status for status, _ in results) == [200, 409]
        winner = next(result for status, result in results if status == 200)
        with Session(engine) as session:
            supervisor = session.get(User, supervisor_id)
            assert list_work_forms(supervisor, session) == [winner]
            updates = [event for event in list_audit_events(session, supervisor) if event["action"] == "work_form_update"]
            assert len(updates) == 1
    print("ok - concurrent version-checked Template edits produce one winner and one audit update")


def test_legacy_and_version_checked_edits_share_atomic_definition_updates():
    with template_database() as (engine, supervisor_id):
        with Session(engine) as session:
            original = new_template(session.get(User, supervisor_id), session)
        barrier = Barrier(2)
        def edit(guarded):
            with Session(engine) as session:
                supervisor = session.get(User, supervisor_id)
                barrier.wait(timeout=5)
                try:
                    request = WorkFormUpdate(name="Checked edit", expected_definition_version=1, confirmed=True) if guarded else WorkFormUpdate(
                        description="Legacy description", confirmed=True,
                    )
                    return 200, update_work_form(original["id"], request, supervisor, session)
                except HTTPException as error:
                    return error.status_code, error.detail
        # Hold the storage write boundary while both callers load their prior
        # view. Legacy writers must re-read after acquiring the shared claim.
        with engine.connect() as blocker:
            blocker.exec_driver_sql("BEGIN IMMEDIATE")
            with ThreadPoolExecutor(max_workers=2) as executor:
                results = [executor.submit(edit, guarded) for guarded in (True, False)]
                time.sleep(0.3)
                blocker.commit()
                checked, legacy = [result.result(timeout=10) for result in results]
        assert legacy[0] == 200 and checked[0] in (200, 409)
        with Session(engine) as session:
            current = list_work_forms(session.get(User, supervisor_id), session)[0]
            assert current["definition_version"] == 2 + (checked[0] == 200)
            assert current["description"] == "Legacy description"
            if checked[0] == 200:
                assert current["name"] == "Checked edit"
    print("ok - legacy and checked edits serialize without losing successful Definition changes")


if __name__ == "__main__":
    test_stale_edit_preserves_newer_template_and_audit()
    test_current_noop_legacy_and_status_updates_preserve_version_semantics()
    test_concurrent_precondition_edits_have_one_winner()
    test_legacy_and_version_checked_edits_share_atomic_definition_updates()
    print("template edit tests passed")
