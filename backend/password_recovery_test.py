"""Private password recovery HTTP checks, using only an owned disposable backend."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from datetime import datetime, timedelta, timezone
import json
import sqlite3
from threading import Barrier

import jwt

from invitation_test import InvitationServer


OLD_PASSWORD = "PreviousWorkerPassword!"
NEW_PASSWORD = "NewWorkerChosenPassword!"
INVALID = "This recovery link is invalid or expired. Ask your Supervisor for a new recovery link."


def worker(server, label, **overrides):
    return server.expect("POST", "/supervisor/users", {
        "email": f"{label}@recovery.invalid", "name": "Recovery Worker", "password": OLD_PASSWORD,
        "role": "worker", **overrides,
    }, 200, server.supervisor)[0]


def issue(server, target):
    return server.expect("POST", f'/supervisor/users/{target["id"]}/password-recovery', {}, 200, server.supervisor)[0]


def login(server, target, password=OLD_PASSWORD):
    return server.expect("POST", "/auth/login", {"email": target["email"], "password": password}, 200)[0]["access_token"]


def inspect(server, token, expected=200):
    return server.expect("POST", "/auth/worker-password-recovery/inspect", {"token": token}, expected)[0]


def accept(server, token, password=NEW_PASSWORD, expected=200, headers=None):
    return server.expect("POST", "/auth/worker-password-recovery/accept", {"token": token, "password": password}, expected, headers=headers)


def check_headers(headers):
    assert headers.get("Cache-Control") == "private, no-store"
    assert headers.get("Referrer-Policy") == "no-referrer"
    assert not headers.get_all("Set-Cookie")


def test_reset_revokes_all_prior_sessions(server):
    target = worker(server, "sessions")
    # Model an account that existed before migration0022.
    with closing(sqlite3.connect(server.database_path)) as connection:
        connection.execute('UPDATE "user" SET legacy_auth_allowed = TRUE WHERE id = ?', (target["id"],))
        connection.commit()
    before = login(server, target)
    legacy = jwt.encode({"sub": target["email"], "exp": datetime.now(timezone.utc) + timedelta(hours=1)},
                        server.environment["GEO_SECRET_KEY"], algorithm="HS256")
    server.expect("GET", "/auth/me", None, 200, legacy)
    _, refresh_headers = server.expect("POST", "/auth/refresh", {}, 200, before)
    refreshed = next(value.split(";", 1)[0].split("=", 1)[1] for value in refresh_headers.get_all("Set-Cookie") if value.startswith("__session="))
    recovery = issue(server, target)
    assert recovery["delivery_method"] == "manual" and recovery["user"]["password_recovery_status"] == "pending"
    remaining = datetime.fromisoformat(recovery["expires_at"]) - datetime.now(timezone.utc)
    assert timedelta(minutes=58) < remaining <= timedelta(minutes=60)
    assert inspect(server, recovery["token"])["email"] == target["email"]
    login(server, target)
    _, headers = accept(server, recovery["token"], headers={"Cookie": f"__session={server.supervisor}"})
    check_headers(headers)
    server.expect("GET", "/auth/me", None, 200, server.supervisor)
    for prior in (before, refreshed, legacy):
        server.expect("GET", "/auth/me", None, 401, prior)
        server.expect("POST", "/auth/refresh", {}, 401, prior)
        server.expect("GET", "/auth/me", None, 401, headers={"Cookie": f"__session={prior}"})
    current = login(server, target, NEW_PASSWORD)
    assert jwt.decode(current, server.environment["GEO_SECRET_KEY"], algorithms=["HS256"])["auth_generation"] == 1
    server.expect("GET", "/auth/me", None, 200, current)
    server.expect("POST", "/auth/refresh", {}, 200, current)
    server.expect("POST", "/auth/login", {"email": target["email"], "password": OLD_PASSWORD}, 401)
    assert inspect(server, recovery["token"], 400)["detail"] == INVALID
    accept(server, recovery["token"], expected=400)
    print("ok - cookie-free reset revokes legacy, bearer, cookie and refreshed sessions; new password signs in")


def test_scope_and_eligibility(server):
    target = worker(server, "eligible")
    pending = server.invite("pending-recovery@example.com")["user"]
    resigned = worker(server, "resigned")
    server.expect("POST", f'/supervisor/users/{resigned["id"]}/status', {"status": "resigned", "confirmed": True}, 200, server.supervisor)
    supervisor = worker(server, "supervisor-target", role="supervisor")
    scoped = worker(server, "scope-supervisor", role="supervisor", department_id=1)
    other = worker(server, "other-department", department_id=2)
    scoped_token = login(server, scoped)
    for method in ("POST", "DELETE"):
        for forbidden in (pending, resigned, supervisor):
            server.expect(method, f'/supervisor/users/{forbidden["id"]}/password-recovery', {}, 409, server.supervisor)
        server.expect(method, f'/supervisor/users/{other["id"]}/password-recovery', {}, 404, scoped_token)
        server.expect(method, f'/supervisor/users/{target["id"]}/password-recovery', {}, 403, login(server, target))
        server.expect(method, f'/supervisor/users/{target["id"]}/password-recovery', {}, 401)
    print("ok - only scoped Supervisors recover active established Workers; pending, resigned and Supervisor targets rejected")


def test_reissue_revoke_expiry_and_domain(server):
    target = worker(server, "replacement")
    first = issue(server, target)
    second = issue(server, target)
    assert first["token"] != second["token"]
    assert inspect(server, first["token"], 400)["detail"] == INVALID
    login(server, target)
    result, headers = server.expect("DELETE", f'/supervisor/users/{target["id"]}/password-recovery', None, 200, server.supervisor)
    check_headers(headers)
    assert result["user"]["password_recovery_status"] == "revoked"
    assert inspect(server, second["token"], 400)["detail"] == INVALID
    login(server, target)
    expired = issue(server, target)
    with closing(sqlite3.connect(server.database_path)) as connection:
        connection.execute("UPDATE workerpasswordrecovery SET expires_at = ? WHERE worker_id = ?", ("2000-01-01 00:00:00", target["id"]))
        connection.commit()
    assert inspect(server, expired["token"], 400)["detail"] == INVALID
    accept(server, expired["token"], expected=400)
    pending = server.invite("domain-isolation@example.com")
    assert inspect(server, pending["token"], 400)["detail"] == INVALID
    fresh = issue(server, target)
    server.expect("POST", "/auth/worker-invitations/inspect", {"token": fresh["token"]}, 400)
    print("ok - reissue/revoke/expiry invalidate links without changing passwords; invitation and recovery credentials isolated")


def test_staff_edits_invalidate_and_direct_password_revokes(server):
    for label, changes in (
        ("name", {"name": "Changed Worker"}), ("email", {"email": "changed-email@recovery.invalid"}),
        ("department", {"department_id": 2}), ("role", {"role": "supervisor"}),
        ("class", {"worker_class": "leader"}), ("status", {"status": "resigned"}),
        ("password", {"password": NEW_PASSWORD}),
    ):
        target = worker(server, f"edit-{label}")
        prior = login(server, target)
        recovery = issue(server, target)
        changed, _ = server.expect("PATCH", f'/supervisor/users/{target["id"]}', {"confirmed": True, **changes}, 200, server.supervisor)
        assert changed["password_recovery_status"] == "revoked"
        assert inspect(server, recovery["token"], 400)["detail"] == INVALID
        if label == "password":
            server.expect("GET", "/auth/me", None, 401, prior)
            login(server, target, NEW_PASSWORD)
    target = worker(server, "resign-reactivate")
    recovery = issue(server, target)
    for status in ("resigned", "active"):
        server.expect("POST", f'/supervisor/users/{target["id"]}/status', {"confirmed": True, "status": status}, 200, server.supervisor)
    assert inspect(server, recovery["token"], 400)["detail"] == INVALID
    print("ok - Staff edits and resign/reactivate invalidate recovery; direct password edits revoke prior sessions")


def test_headers_validation_csrf_and_secret_storage(server):
    target = worker(server, "safety")
    recovery = issue(server, target)
    for path, payload, status in (
        ("/auth/worker-password-recovery/inspect", {"token": recovery["token"]}, 200),
        ("/api/auth/worker-password-recovery/inspect", {"token": "x" * 32}, 400),
        ("/auth/worker-password-recovery/accept", {"token": recovery["token"], "password": "short"}, 422),
        ("/auth/worker-password-recovery/accept", {"token": recovery["token"], "password": "界" * 25}, 422),
        ("/auth/worker-password-recovery/accept", {"token": {"secret": recovery["token"]}, "password": NEW_PASSWORD}, 422),
        ("/auth/worker-password-recovery/accept", {"token": recovery["token"], "password": "invalid\ud800password"}, 422),
        ("/auth/worker-password-recovery/inspect", {"token": "\ud800" * 32}, 422),
        ("/auth/worker-password-recovery/inspect", {"token": "界" * 32}, 400),
    ):
        result, headers = server.expect("POST", path, payload, status)
        check_headers(headers)
        encoded = json.dumps(result)
        assert recovery["token"] not in encoded and NEW_PASSWORD not in encoded and "short" not in encoded
    for method in ("POST", "DELETE"):
        _, headers = server.expect(method, f'/supervisor/users/{target["id"]}/password-recovery', {}, 403,
                                   headers={"Cookie": f"__session={server.supervisor}"})
        check_headers(headers)
    csrf = jwt.decode(server.supervisor, server.environment["GEO_SECRET_KEY"], algorithms=["HS256"])["csrf"]
    server.expect("DELETE", f'/supervisor/users/{target["id"]}/password-recovery', {}, 200,
                  headers={"Cookie": f"__session={server.supervisor}", "x-csrf-token": csrf})
    with closing(sqlite3.connect(server.database_path)) as connection:
        hashes = connection.execute("SELECT token_hash FROM workerpasswordrecovery WHERE worker_id = ?", (target["id"],)).fetchall()
        assert hashes and all(row[0] != recovery["token"] for row in hashes)
        audit = str(connection.execute("SELECT before_json, after_json, summary FROM auditevent WHERE entity_type = 'user' AND entity_id = ?", (target["id"],)).fetchall())
        assert recovery["token"] not in audit and NEW_PASSWORD not in audit and OLD_PASSWORD not in audit
    print("ok - recovery responses/errors are no-store/no-referrer/cookie-free; 422 redacts secrets, CSRF enforced, audit/storage hide tokens")


def test_simultaneous_acceptance(server):
    target = worker(server, "race")
    recovery = issue(server, target)
    barrier = Barrier(2)
    def contender(password):
        barrier.wait()
        return server.request("POST", "/auth/worker-password-recovery/accept", {"token": recovery["token"], "password": password})[0]
    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = [executor.submit(contender, password) for password in (NEW_PASSWORD, "OtherChosenPassword!")]
        assert sorted(future.result() for future in futures) == [200, 400]
    with closing(sqlite3.connect(server.database_path)) as connection:
        assert connection.execute('SELECT auth_generation FROM "user" WHERE id = ?', (target["id"],)).fetchone()[0] == 1
        assert connection.execute("SELECT COUNT(*) FROM auditevent WHERE action = 'worker_password_recovery_accept' AND entity_id = ?", (target["id"],)).fetchone()[0] == 1
    print("ok - simultaneous recovery has one successful reset, one audit, one session-generation increment")


def test_email_reuse_never_adopts_old_identity(server):
    for scenario in ("new-account", "reassigned-account"):
        target = worker(server, f"reuse-{scenario}")
        with closing(sqlite3.connect(server.database_path)) as connection:
            connection.execute('UPDATE "user" SET legacy_auth_allowed = TRUE WHERE id = ?', (target["id"],))
            connection.commit()
        legacy = jwt.encode({"sub": target["email"], "exp": datetime.now(timezone.utc) + timedelta(hours=1)},
                            server.environment["GEO_SECRET_KEY"], algorithm="HS256")
        fresh = login(server, target)
        server.expect("GET", "/auth/me", None, 200, legacy)
        reset = issue(server, target)
        accept(server, reset["token"])
        server.expect("PATCH", f'/supervisor/users/{target["id"]}', {
            "confirmed": True, "email": f"moved-{scenario}@recovery.invalid",
        }, 200, server.supervisor)
        if scenario == "new-account":
            replacement = worker(server, f"reuse-{scenario}")
        else:
            replacement = worker(server, "legacy-reassignment-destination")
            with closing(sqlite3.connect(server.database_path)) as connection:
                connection.execute('UPDATE "user" SET legacy_auth_allowed = TRUE WHERE id = ?', (replacement["id"],))
                connection.commit()
            replacement, _ = server.expect("PATCH", f'/supervisor/users/{replacement["id"]}', {
                "confirmed": True, "email": target["email"],
            }, 200, server.supervisor)
        for old in (legacy, fresh):
            server.expect("GET", "/auth/me", None, 401, old)
            server.expect("POST", "/auth/refresh", {}, 401, old)
        login(server, replacement)
    print("ok - recycled email addresses never inherit a previous identity's legacy or uid-bound session")


def test_recovery_rate_limit_bucket():
    from app.main import rate_limiter
    from app.rate_limit import InMemoryRateLimiter, RateLimitRule
    from security_test import FakeRequest
    for path in ("/auth/worker-password-recovery/inspect", "/api/auth/worker-password-recovery/accept",
                 "/supervisor/users/3/password-recovery", "/api/supervisor/users/3/password-recovery"):
        limiter = InMemoryRateLimiter(enabled=True, default_rule=RateLimitRule("general", 100, 60),
                                      rules=[RateLimitRule(rule.name, 1, 60, rule.path_prefixes) for rule in rate_limiter.rules])
        assert limiter.check(FakeRequest("/auth/login")) is None
        assert limiter.check(FakeRequest(path)).status_code == 429
    print("ok - recovery inspect, acceptance, issue and revoke paths share the strict authentication rate bucket")


def main():
    with InvitationServer() as server:
        with closing(sqlite3.connect(server.database_path)) as connection:
            connection.execute('UPDATE "user" SET is_global_admin = TRUE WHERE email = ?', ("supervisor@example.com",))
            connection.commit()
        for check in (test_reset_revokes_all_prior_sessions, test_scope_and_eligibility,
                      test_reissue_revoke_expiry_and_domain, test_staff_edits_invalidate_and_direct_password_revokes,
                      test_headers_validation_csrf_and_secret_storage, test_simultaneous_acceptance,
                      test_email_reuse_never_adopts_old_identity):
            check(server)
    test_recovery_rate_limit_bucket()
    print("Private password recovery checks passed; disposable backend removed.")


if __name__ == "__main__":
    main()
