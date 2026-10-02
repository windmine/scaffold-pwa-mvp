"""Report inbox ordering HTTP checks against an owned disposable backend."""
import base64
from contextlib import closing
from datetime import datetime, timezone
import hashlib
import json
import sqlite3
from urllib.parse import urlencode
from uuid import uuid4

from invitation_test import InvitationServer


def sign_in(server, email, password="Passw0rd!"):
    result, _ = server.expect("POST", "/auth/login", {
        "email": email, "password": password,
    }, 200)
    return result["user"], result["access_token"]


def new_template(server, label, token=None):
    return server.expect("POST", "/supervisor/work-forms", {
        "name": label,
        "fields": [{"id": "detail", "label": "Detail", "type": "text"}],
    }, 200, token or server.supervisor)[0]


def new_report(server, template, *, token=None, created_at="2026-01-02 08:00:00.000000",
               workflow="submitted", report_date="2026-01-01", detail="Ordering fixture",
               purpose="report"):
    worker = server.worker if token is None else server.expect("GET", "/auth/me", None, 200, token)[0]
    # Seed immutable historical timestamps at INSERT, without disabling guards.
    # All rows belong exclusively to this owned disposable test database.
    with closing(sqlite3.connect(server.database_path)) as connection:
        if purpose == "daywork":
            connection.execute("UPDATE workform SET template_purpose = 'daywork' WHERE id = ?", (template["id"],))
        result = connection.execute(
            "INSERT INTO workformsubmission (department_id, form_id, worker_id, work_date, answers_json, "
            "client_submission_id, form_definition_version, submission_purpose, workflow_status, status, "
            "created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, 'submitted', 'pending', ?)",
            (worker["department_id"], template["id"], worker["id"], report_date, json.dumps({"detail": detail}),
             str(uuid4()), purpose, created_at),
        )
        report_id = result.lastrowid
        connection.execute(
            "UPDATE workformsubmission SET workflow_status = ?, review_started_at = ?, resolved_at = ? WHERE id = ?",
            (workflow,
             "2026-01-03 08:00:00.000000" if workflow != "submitted" else None,
             "2026-01-04 08:00:00.000000" if workflow == "resolved" else None, report_id),
        )
        if purpose == "daywork":
            connection.execute("UPDATE workform SET template_purpose = 'report' WHERE id = ?", (template["id"],))
        connection.commit()
    return report_id


def queue(server, token=None, expected=200, **query):
    return server.expect("GET", "/supervisor/review-queue?" + urlencode(query),
                         None, expected, token or server.supervisor)[0]


def oldest(server, template=None, **query):
    filters = {"purpose": "report", "sort_order": "oldest_waiting", **query}
    if template is not None:
        filters["form_id"] = template["id"]
    return queue(server, **filters)


def ids(page):
    return [item["id"] for item in page["items"]]


def read_cursor(cursor):
    return json.loads(base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)))


def encode_cursor(payload):
    return base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip("=")


def traverse(server, template, first, **query):
    seen = ids(first)
    page = first
    while page["has_more"]:
        assert page["next_cursor"], "Every nonterminal page needs a cursor"
        page = oldest(server, template, cursor=page["next_cursor"], **query)
        assert page["snapshot_at"] == first["snapshot_at"]
        assert page["counts"] == first["counts"]
        seen.extend(ids(page))
    assert page["next_cursor"] is None
    assert len(seen) == len(set(seen)), "A Report cannot appear twice in a snapshot traversal"
    return seen


def test_rank_time_and_tied_id_order(server):
    template = new_template(server, "Rank and stable ties")
    resolved = new_report(server, template, workflow="resolved", created_at="2026-01-01 08:00:00.000000")
    in_review = new_report(server, template, workflow="in_review", created_at="2026-01-01 08:00:00.000000")
    newer = new_report(server, template, created_at="2026-01-02 08:00:00.000000", report_date="2020-01-01")
    tied_first = new_report(server, template, created_at="2026-01-01 08:00:00.000000", report_date="2030-01-01")
    tied_second = new_report(server, template, created_at="2026-01-01 08:00:00.000000")
    in_review_newer = new_report(server, template, workflow="in_review")
    resolved_newer = new_report(server, template, workflow="resolved")
    expected = [tied_first, tied_second, newer, in_review, in_review_newer, resolved, resolved_newer]
    for size in (1, 2, 3, 100):
        page = oldest(server, template, page_size=size)
        assert page["sort_order"] == "oldest_waiting"
        assert page["counts"]["total"] == 7
        assert traverse(server, template, page, page_size=size) == expected
    one = oldest(server, template, page_size=1)
    cursor = read_cursor(one["next_cursor"])
    assert cursor["sort_order"] == "oldest_waiting" and cursor["workflow_rank"] == 0
    assert cursor["id"] == tied_first and cursor["kind"] == "form"
    assert len(cursor["order_snapshot_hash"]) == 64 and len(one["next_cursor"]) < 700
    assert all(item["created_at"].endswith("Z") for item in oldest(server, template)["items"])
    print("ok - oldest waiting ranks workflows, uses durable submission time, and pages exact ties by ascending ID")


def test_snapshot_excludes_later_submissions(server):
    template = new_template(server, "Insertion snapshot")
    expected = [new_report(server, template) for _ in range(4)]
    page = oldest(server, template, page_size=1)
    late_time = datetime.now(timezone.utc).replace(tzinfo=None).isoformat(" ")
    late = new_report(server, template, created_at=late_time)
    assert traverse(server, template, page, page_size=1) == expected
    assert ids(oldest(server, template)) == expected + [late]
    print("ok - first-page creation snapshot excludes a later Report until refresh")


def test_snapshot_rank_survives_forward_transitions(server):
    template = new_template(server, "Workflow snapshot")
    submitted = [new_report(server, template) for _ in range(3)]
    reviewing = new_report(server, template, workflow="in_review")
    resolved = new_report(server, template, workflow="resolved")
    first = oldest(server, template, page_size=1)
    filtered = oldest(server, template, page_size=1, workflow_status="submitted")
    # Move both an already-seen and an unseen Report through both transitions.
    for report_id in (submitted[0], submitted[1], reviewing):
        if report_id != reviewing:
            server.expect("POST", f"/supervisor/form-submissions/{report_id}/transition",
                          {"status": "in_review"}, 200, server.supervisor)
        server.expect("POST", f"/supervisor/form-submissions/{report_id}/transition", {
            "status": "resolved", "supervisor_note": "Owned snapshot fixture",
        }, 200, server.supervisor)
    assert traverse(server, template, first, page_size=1) == submitted + [reviewing, resolved]
    assert traverse(server, template, filtered, page_size=1, workflow_status="submitted") == submitted
    second = oldest(server, template, cursor=filtered["next_cursor"], page_size=1,
                    workflow_status="submitted")
    assert second["items"][0]["workflow_status"] == "resolved", "Serialization must show current authoritative state"
    assert ids(oldest(server, template, workflow_status="submitted")) == [submitted[2]]
    print("ok - forward transitions preserve snapshot rank and workflow membership without stale serialized state")


def begin_held_transition(connection, report_ids):
    connection.execute("BEGIN IMMEDIATE")
    for report_id in report_ids:
        connection.execute(
            "UPDATE workformsubmission SET workflow_status = 'in_review', review_started_at = ? WHERE id = ?",
            (datetime.now(timezone.utc).replace(tzinfo=None).isoformat(" "), report_id),
        )


def check_late_transition_commit(server, workflow_status=None):
    label = workflow_status or "all workflows"
    template = new_template(server, f"Held transition {label}")
    reports = [new_report(server, template) for _ in range(3)]
    filters = {"workflow_status": workflow_status} if workflow_status else {}
    with closing(sqlite3.connect(server.database_path)) as writer:
        # Operation timestamps precede the snapshot, but its first SELECT cannot
        # see this transaction until the writer commits after the response.
        begin_held_transition(writer, reports[:2])
        first = oldest(server, template, page_size=1, **filters)
        assert ids(first) == [reports[0]] and first["counts"]["total"] == 3
        writer.commit()
    query = {"purpose": "report", "sort_order": "oldest_waiting", "form_id": template["id"],
             "page_size": 1, "cursor": first["next_cursor"], **filters}
    status, result, _ = server.request("GET", "/supervisor/review-queue?" + urlencode(query), token=server.supervisor)
    if status == 200:
        observed = ids(first) + ids(result)
        changed_count = result["counts"]["total"]
        while result["has_more"] and len(observed) < 10:
            result = oldest(server, template, cursor=result["next_cursor"], page_size=1, **filters)
            observed.extend(ids(result))
        raise AssertionError(
            f"{label}: late commit must invalidate traversal, got IDs {observed}, "
            f"original IDs {reports}, matching count 3 -> {changed_count}"
        )
    assert status == 409 and result["detail"]["code"] == "report_review_order_changed"
    assert "refresh" in result["detail"]["message"].lower()
    refreshed = oldest(server, template, **filters)
    assert ids(refreshed) == ([reports[2]] if workflow_status else [reports[2], *reports[:2]])
    print(f"ok - held pre-snapshot transition commit invalidates {label} traversal with explicit Refresh guidance")


def test_late_transition_commit_all_workflows(server):
    check_late_transition_commit(server)


def test_late_transition_commit_submitted_workflow(server):
    check_late_transition_commit(server, "submitted")


def test_transition_commit_between_request_reads(server):
    from fastapi import HTTPException
    from sqlmodel import Session, create_engine, select
    from app.models import User
    from app.use_cases.review_queue import list_review_record_page

    class CommitBetweenReads:
        def __init__(self, session, writer, commit_after):
            self.session = session
            self.writer = writer
            self.commit_after = commit_after
            self.committed = False

        def __getattr__(self, name):
            return getattr(self.session, name)

        def exec(self, statement):
            result = self.session.exec(statement)
            names = list(statement.selected_columns.keys())
            read_kind = (
                "counts" if "record_count" in names
                else "page" if "record_kind" in names and "record_id" in names
                else "load" if "workflow_status" in names and "id" in names
                else None
            )
            owner = self

            class Result:
                def __getattr__(self, name):
                    return getattr(result, name)

                def __iter__(self):
                    return iter(result)

                def all(self):
                    rows = result.all()
                    if not owner.committed and read_kind == owner.commit_after:
                        owner.writer.commit()
                        owner.committed = True
                    return rows

            return Result()

    engine = create_engine(f"sqlite:///{server.database_path.as_posix()}")
    try:
        for commit_after in ("page", "load", "counts"):
            for workflow_status in (None, "submitted"):
                template = new_template(server, f"Commit after {commit_after} {workflow_status}")
                reports = [new_report(server, template) for _ in range(3)]
                with Session(engine) as session, closing(sqlite3.connect(server.database_path)) as writer:
                    supervisor = session.exec(select(User).where(User.email == "supervisor@example.com")).one()
                    begin_held_transition(writer, reports[:2])
                    reader = CommitBetweenReads(session, writer, commit_after)
                    try:
                        result = list_review_record_page(
                            reader, supervisor, purpose="report", sort_order="oldest_waiting",
                            form_id=template["id"], page_size=1, workflow_status=workflow_status,
                        )
                    except HTTPException as error:
                        assert reader.committed and error.status_code == 409
                        assert error.detail["code"] == "report_review_order_changed"
                    else:
                        raise AssertionError(
                            f"Commit after {commit_after} ({workflow_status}) must invalidate first page; "
                            f"returned IDs {ids(result)}, count {result['counts']['total']}"
                        )
    finally:
        engine.dispose()
    print("ok - first-page pre-snapshot commits between page/load/count reads fail closed for All and Submitted")


def test_filters_and_counts_stay_server_side(server):
    template = new_template(server, "Structured filters")
    target = new_report(server, template, detail="Exact needle", report_date="2026-02-03")
    new_report(server, template, detail="No match", report_date="2026-02-03")
    new_report(server, template, detail="Exact needle", report_date="2026-02-04")
    new_report(server, template, detail="Exact needle", report_date="2026-02-03", workflow="in_review")
    page = oldest(server, template, kind="form", workflow_status="submitted", search="Exact needle",
                  worker_id=server.worker["id"], record_date="2026-02-03", page_size=1)
    assert ids(page) == [target] and page["counts"]["total"] == 1
    assert page["summary_counts"]["total"] > 1 and page["has_more"] is False
    newest = queue(server, purpose="report", form_id=template["id"], kind="form",
                   workflow_status="submitted", search="Exact needle", worker_id=server.worker["id"],
                   record_date="2026-02-03", sort_order="newest")
    assert page["counts"] == newest["counts"] and page["summary_counts"] == newest["summary_counts"]
    assert oldest(server, template, kind="attendance")["items"] == []
    assert oldest(server, template, worker_id=999999)["items"] == []
    print("ok - workflow, Template, Worker, Date, Find and kind filters execute before paging with unchanged counts")


def test_filter_and_sort_bound_cursors(server):
    template = new_template(server, "Cursor binding")
    for _ in range(3):
        new_report(server, template)
    base = {"purpose": "report", "form_id": template["id"], "page_size": 1}
    old_cursor = queue(server, **base, sort_order="oldest_waiting")["next_cursor"]
    new_cursor = queue(server, **base)["next_cursor"]
    queue(server, **base, cursor=old_cursor, expected=400)
    queue(server, **base, sort_order="oldest_waiting", cursor=new_cursor, expected=400)
    for changed in ({"workflow_status": "submitted"}, {"worker_id": server.worker["id"]},
                    {"record_date": "2026-01-01"}, {"search": "fixture"}, {"kind": "form"},
                    {"form_id": template["id"] + 1000}):
        queue(server, **{**base, **changed}, sort_order="oldest_waiting", cursor=old_cursor, expected=400)
    payload = read_cursor(old_cursor)
    for rank in (None, -1, 3, "0", True):
        queue(server, **base, sort_order="oldest_waiting", expected=400,
              cursor=encode_cursor({**payload, "workflow_rank": rank}))
    for digest in (None, "", "f" * 63, "g" * 64, 1, True):
        queue(server, **base, sort_order="oldest_waiting", expected=400,
              cursor=encode_cursor({**payload, "order_snapshot_hash": digest}))
    no_digest = {key: value for key, value in payload.items() if key != "order_snapshot_hash"}
    queue(server, **base, sort_order="oldest_waiting", expected=400, cursor=encode_cursor(no_digest))
    mismatch = queue(server, **base, sort_order="oldest_waiting", expected=409,
                     cursor=encode_cursor({**payload, "order_snapshot_hash": "0" * 64}))
    assert mismatch["detail"]["code"] == "report_review_order_changed"
    for malformed in ("not-base64", encode_cursor([])):
        queue(server, **base, sort_order="oldest_waiting", cursor=malformed, expected=400)
    assert queue(server, **base, sort_order="newest", cursor=new_cursor)["items"]
    print("ok - cursors bind ordering, filters and exact digest; malformed/missing ranks or digests fail closed")


def test_digest_includes_keys_beyond_streaming_batch(server):
    template = new_template(server, "Full exact key digest")
    with closing(sqlite3.connect(server.database_path)) as connection:
        connection.executemany(
            "INSERT INTO workformsubmission (department_id, form_id, worker_id, work_date, answers_json, "
            "client_submission_id, form_definition_version, submission_purpose, workflow_status, status, "
            "created_at) VALUES (?, ?, ?, '2026-01-01', '{}', ?, 1, 'report', 'submitted', 'pending', "
            "'2026-01-02 08:00:00.000000')",
            [(server.worker["department_id"], template["id"], server.worker["id"], str(uuid4())) for _ in range(600)],
        )
        last = connection.execute("SELECT max(id) FROM workformsubmission WHERE form_id = ?", (template["id"],)).fetchone()[0]
        connection.commit()
    first = oldest(server, template, page_size=1)
    assert first["counts"]["total"] == 600 and len(first["next_cursor"]) < 700
    with closing(sqlite3.connect(server.database_path)) as writer:
        # A late-visible historical operation changes only a far-off rank, not
        # membership/count. The digest must include keys beyond two batches.
        writer.execute(
            "UPDATE workformsubmission SET workflow_status = 'in_review', "
            "review_started_at = '2026-01-03 08:00:00.000000' WHERE id = ?", (last,),
        )
        writer.commit()
    error = oldest(server, template, cursor=first["next_cursor"], page_size=1, expected=409)
    assert error["detail"]["code"] == "report_review_order_changed"
    print("ok - constant-size cursor binds every matching key across multiple 256-row streaming batches")


def test_invalid_sort_and_report_only_boundary(server):
    for sort_order in ("", "oldest", "created_at", "pending", "oldest waiting"):
        queue(server, purpose="report", sort_order=sort_order, expected=400)
    for purpose in (None, "daywork"):
        query = {"sort_order": "oldest_waiting"}
        if purpose is not None:
            query["purpose"] = purpose
        queue(server, **query, expected=400)
    assert queue(server, purpose="report", sort_order=" OLDEST_WAITING ")["sort_order"] == "oldest_waiting"
    assert queue(server, sort_order=" NEWEST ")["sort_order"] == "newest"
    server.expect("GET", "/supervisor/review-queue?purpose=report&sort_order=oldest_waiting", None, 401)
    queue(server, token=server.worker_token, purpose="report", sort_order="oldest_waiting", expected=403)
    print("ok - ordering validation, Report-only purpose, authentication and Supervisor role boundaries hold")


def test_department_scope_and_global_focus(server):
    _, admin_token = sign_in(server, "admin@example.com")
    with closing(sqlite3.connect(server.database_path)) as connection:
        other_department = connection.execute("SELECT id FROM department WHERE id != ? ORDER BY id",
                                              (server.worker["department_id"],)).fetchone()[0]
    tokens = {}
    for role in ("supervisor", "worker"):
        email = f"order-{role}@scope.invalid"
        server.expect("POST", "/supervisor/users", {
            "email": email, "name": f"Other {role}", "password": "ScopeFixturePassword!",
            "role": role, "department_id": other_department,
        }, 200, admin_token)
        _, tokens[role] = sign_in(server, email, "ScopeFixturePassword!")
    template = new_template(server, "Other Department order", tokens["supervisor"])
    remote = new_report(server, template, token=tokens["worker"])
    query = {"purpose": "report", "sort_order": "oldest_waiting", "form_id": template["id"]}
    assert queue(server, **query)["items"] == []
    queue(server, **query, department_id=other_department, expected=404)
    assert ids(queue(server, **query, token=admin_token)) == [remote]
    assert ids(queue(server, **query, token=admin_token, department_id=other_department)) == [remote]
    assert ids(queue(server, **query, token=tokens["supervisor"])) == [remote]
    global_first = queue(server, token=admin_token, purpose="report", sort_order="oldest_waiting", page_size=1)
    queue(server, token=admin_token, purpose="report", sort_order="oldest_waiting", page_size=1,
          department_id=other_department, cursor=global_first["next_cursor"], expected=400)
    print("ok - local Supervisor scope, Global admin focus and Department-bound cursors remain enforced")


def test_newest_legacy_and_deleted_exclusions(server):
    template = new_template(server, "Legacy order preservation")
    older = new_report(server, template, created_at="2026-01-01 08:00:00.000000")
    newer = new_report(server, template)
    tied = new_report(server, template)
    legacy = new_report(server, template, purpose="daywork")
    deleted = new_report(server, template)
    with closing(sqlite3.connect(server.database_path)) as connection:
        connection.execute("UPDATE workformsubmission SET deleted_at = ? WHERE id = ?",
                           (datetime.now(timezone.utc).replace(tzinfo=None).isoformat(" "), deleted))
        connection.commit()
    default = queue(server, purpose="report", form_id=template["id"])
    explicit = queue(server, purpose="report", form_id=template["id"], sort_order="newest")
    assert ids(default) == ids(explicit) == [tied, newer, older]
    assert ids(oldest(server, template)) == [older, newer, tied]
    assert ids(queue(server, form_id=template["id"])) == [legacy, tied, newer, older]
    assert ids(queue(server, purpose="daywork", form_id=template["id"])) == [legacy]
    implicit_page = queue(server, form_id=template["id"], page_size=1)
    payload = read_cursor(implicit_page["next_cursor"])
    assert "sort_order" not in payload and "workflow_rank" not in payload, "Existing newest cursor format is preserved"
    assert ids(queue(server, form_id=template["id"], page_size=100, sort_order="newest",
                     cursor=implicit_page["next_cursor"])) == [tied, newer, older]
    print("ok - newest/default/retained Daywork behavior and historical cursors remain unchanged; deleted Reports stay excluded")


def test_postgresql_query_compilation():
    # No provider or local database connection: exercise the actual page-query
    # construction with PostgreSQL's dialect, including cursor/filter clauses.
    from sqlalchemy.dialects import postgresql
    from app.models import User
    from app.use_cases.review_queue import (
        _encode_cursor,
        list_review_record_page,
        normalize_review_record_query,
    )

    class CompileSession:
        def __init__(self):
            self.statements = []
            self.options = []

        def exec(self, statement):
            self.options.append(statement.get_execution_options())
            self.statements.append(str(statement.compile(
                dialect=postgresql.dialect(), compile_kwargs={"literal_binds": True},
            )))
            return self

        def all(self):
            return []

        def __iter__(self):
            return iter(())

        def close(self):
            pass

    supervisor = User(id=1, department_id=1, role="supervisor", email="compile@fixture.invalid",
                      name="Compile fixture", password_hash="not-a-login")
    filters = {"purpose": "report", "kind": "form", "workflow_status": "submitted",
               "form_id": 1, "worker_id": 2, "record_date": "2026-01-01", "search": "needle"}
    query = normalize_review_record_query(supervisor, **filters)
    now = datetime.now(timezone.utc)
    for order in ("oldest_waiting", "newest"):
        session = CompileSession()
        cursor = _encode_cursor(now, now, "form", 1, query.fingerprint(order),
                                sort_order=order, workflow_rank=0 if order == "oldest_waiting" else None,
                                order_snapshot_hash=hashlib.sha256(b"").hexdigest())
        result = list_review_record_page(session, supervisor, **filters, sort_order=order, cursor=cursor)
        sql = session.statements[1 if order == "oldest_waiting" else 0]
        assert result["sort_order"] == order and len(session.statements) == (5 if order == "oldest_waiting" else 3)
        assert "workformsubmission.created_at <=" in sql and "workformsubmission.submission_purpose = 'report'" in sql
        if order == "oldest_waiting":
            for index in (0, -1):
                assert session.options[index]["yield_per"] == 256
                assert "ORDER BY review_queue.record_id ASC" in session.statements[index]
                assert "LIMIT" not in session.statements[index]
            assert "CASE WHEN" in sql and "review_queue.workflow_rank > 0" in sql
            assert "review_queue.record_id > 1" in sql
            assert "ORDER BY review_queue.workflow_rank ASC, review_queue.created_at ASC, review_queue.record_id ASC" in sql
        else:
            assert "review_queue.record_id < 1" in sql
            assert "ORDER BY review_queue.created_at DESC, review_queue.record_kind ASC, review_queue.record_id DESC" in sql
    print("ok - both actual page-query paths compile with PostgreSQL cursor, snapshot, filter and ordering predicates (no runtime claim)")


def main():
    with InvitationServer() as server:
        server.worker, server.worker_token = sign_in(server, "worker@example.com")
        for test in (
            test_rank_time_and_tied_id_order,
            test_snapshot_excludes_later_submissions,
            test_snapshot_rank_survives_forward_transitions,
            test_late_transition_commit_all_workflows,
            test_late_transition_commit_submitted_workflow,
            test_transition_commit_between_request_reads,
            test_filters_and_counts_stay_server_side,
            test_filter_and_sort_bound_cursors,
            test_digest_includes_keys_beyond_streaming_batch,
            test_invalid_sort_and_report_only_boundary,
            test_department_scope_and_global_focus,
            test_newest_legacy_and_deleted_exclusions,
        ):
            test(server)
    test_postgresql_query_compilation()
    print("report review order test passed (11 HTTP groups + six in-request race cases + PostgreSQL compilation)")


if __name__ == "__main__":
    main()
