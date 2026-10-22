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


def test_newest_filter_pagination(server):
    template = new_template(server, "Submitted Report pagination")
    first = new_report(server, template, report_date="2026-01-01", detail="needle")
    second = new_report(server, template, report_date="2026-01-01", detail="needle")
    new_report(server, template, report_date="2026-01-02", detail="outside date")
    filters = {"purpose": "report", "form_id": template["id"], "worker_id": server.worker["id"],
               "record_date": "2026-01-01", "search": "needle", "page_size": 1}
    page = queue(server, **filters)
    assert ids(page) == [second] and page["counts"]["total"] == 2
    assert ids(queue(server, **filters, cursor=page["next_cursor"])) == [first]
    assert all(item["workflow_status"] == "submitted" for item in page["items"])
    query = {**filters, "record_date": "2026-01-02", "cursor": page["next_cursor"]}
    queue(server, expected=400, **query)
    print("ok - newest pagination binds Department/Template/Worker/Date/search filters")


def test_invalid_sort_and_report_only_boundary(server):
    for sort_order in ("", "oldest", "created_at", "pending", "oldest waiting"):
        queue(server, purpose="report", sort_order=sort_order, expected=400)
    for purpose in (None, "daywork"):
        query = {"sort_order": "oldest_waiting"}
        if purpose is not None:
            query["purpose"] = purpose
        queue(server, **query, expected=400)
    queue(server, purpose="report", sort_order=" OLDEST_WAITING ", expected=400)
    for workflow in ("in_review", "resolved"):
        queue(server, purpose="report", workflow_status=workflow, expected=400)
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
    query = {"purpose": "report", "sort_order": "newest", "form_id": template["id"]}
    assert queue(server, **query)["items"] == []
    queue(server, **query, department_id=other_department, expected=404)
    assert ids(queue(server, **query, token=admin_token)) == [remote]
    assert ids(queue(server, **query, token=admin_token, department_id=other_department)) == [remote]
    assert ids(queue(server, **query, token=tokens["supervisor"])) == [remote]
    global_first = queue(server, token=admin_token, purpose="report", sort_order="newest", page_size=1)
    queue(server, token=admin_token, purpose="report", sort_order="newest", page_size=1,
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
    for order in ("newest",):
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
    print("ok - current page-query path compiles with PostgreSQL cursor, snapshot, filter and ordering predicates (no runtime claim)")


def main():
    with InvitationServer() as server:
        server.worker, server.worker_token = sign_in(server, "worker@example.com")
        for test in (
            test_newest_filter_pagination,
            test_invalid_sort_and_report_only_boundary,
            test_department_scope_and_global_focus,
            test_newest_legacy_and_deleted_exclusions,
        ):
            test(server)
    test_postgresql_query_compilation()
    print("Report newest pagination and retired review filter tests passed (four HTTP groups + PostgreSQL compilation)")


if __name__ == "__main__":
    main()
