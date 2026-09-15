"""Worker invitation HTTP regressions against an owned disposable SQLite backend."""
import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import sys
from tempfile import TemporaryDirectory
import time
from datetime import datetime, timedelta, timezone
import jwt
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from contextlib import closing
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


class InvitationServer:
    def __enter__(self):
        self.directory = TemporaryDirectory(prefix="worker-invitation-test-")
        self.database_path = Path(self.directory.name) / "test.db"
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        self.base_url = f"http://127.0.0.1:{port}"
        self.environment = {
            **os.environ,
            "DATABASE_URL": f"sqlite:///{Path(self.directory.name).as_posix()}/test.db",
            "UPLOAD_DIR": str(Path(self.directory.name) / "uploads"),
            "UPLOAD_STORAGE_BACKEND": "local", "UPLOAD_BUCKET": "",
            "APP_ENV": "development", "K_SERVICE": "", "AUTO_MIGRATE": "true",
            "ENABLE_DEV_SEED": "true", "RATE_LIMIT_ENABLED": "false", "SQL_ECHO": "false",
            "AUTH_COOKIE_SECURE": "false", "SMTP_HOST": "", "SMTP_FROM_EMAIL": "",
            "GEO_SECRET_KEY": "owned-worker-invitation-fixture-secret-not-a-production-credential",
        }
        self.process = subprocess.Popen(
            [sys.executable, "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", str(port)],
            cwd=Path(__file__).resolve().parent, env=self.environment,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        try:
            for _ in range(100):
                if self.process.poll() is not None:
                    raise AssertionError("Owned invitation backend did not start")
                try:
                    if self.request("GET", "/health")[0] == 200:
                        break
                except (URLError, TimeoutError):
                    time.sleep(0.1)
            else:
                raise AssertionError("Owned invitation backend readiness timed out")
            self.expect("POST", "/dev/seed", {}, 200)
            self.supervisor = self.expect("POST", "/auth/login", {
                "email": "supervisor@example.com", "password": "Passw0rd!",
            }, 200)[0]["access_token"]
            return self
        except BaseException:
            self.__exit__(None, None, None)
            raise

    def __exit__(self, *_):
        self.process.terminate()
        self.process.wait(timeout=15)
        self.directory.cleanup()

    def request(self, method, path, payload=None, token=None):
        request = Request(self.base_url + path, method=method,
                          data=json.dumps(payload).encode() if payload is not None else None)
        if payload is not None:
            request.add_header("Content-Type", "application/json")
        if token:
            request.add_header("Authorization", f"Bearer {token}")
        try:
            response = urlopen(request, timeout=10)
        except HTTPError as error:
            response = error
        with response:
            body = response.read()
            return response.status, json.loads(body) if body else None, response.headers

    def expect(self, method, path, payload, expected, token=None):
        status, body, headers = self.request(method, path, payload, token)
        # Never include response payloads: successful issuance contains a credential.
        assert status == expected, f"{method} {path}: expected {expected}, got {status}"
        return body, headers

    def invite(self, email="invited-worker@example.com"):
        return self.expect("POST", "/supervisor/worker-invitations", {
            "name": "Invited Worker", "email": email, "worker_class": "normal",
        }, 200, self.supervisor)[0]


def test_worker_sets_their_own_password(server):
    invitation = server.invite()
    assert invitation["delivery_method"] == "manual"
    assert invitation["user"]["password_setup_required"] is True
    inspected, _ = server.expect("POST", "/auth/worker-invitations/inspect", {
        "token": invitation["token"],
    }, 200)
    assert inspected["email"] == "invited-worker@example.com"
    _, headers = server.expect("POST", "/auth/worker-invitations/accept", {
        "token": invitation["token"], "password": "WorkerChosenPassword!",
    }, 200)
    assert not headers.get_all("Set-Cookie"), "Password setup must not switch the browser account"
    signed_in, _ = server.expect("POST", "/auth/login", {
        "email": inspected["email"], "password": "WorkerChosenPassword!",
    }, 200)
    assert signed_in["user"]["password_setup_required"] is False
    print("ok - invited Worker chooses a password then signs in normally")


def test_only_latest_unrevoked_invitation_can_be_used(server):
    invitation = server.invite("reissued-worker@example.com")
    replacement, _ = server.expect("POST", f'/supervisor/users/{invitation["user"]["id"]}/invitation', {}, 200, server.supervisor)
    assert replacement["token"] != invitation["token"]
    server.expect("POST", "/auth/worker-invitations/inspect", {"token": invitation["token"]}, 400)
    server.expect("POST", "/auth/worker-invitations/accept", {
        "token": invitation["token"], "password": "MustNotBeAccepted!",
    }, 400)
    server.expect("POST", "/auth/worker-invitations/inspect", {"token": replacement["token"]}, 200)
    server.expect("DELETE", f'/supervisor/users/{invitation["user"]["id"]}/invitation', None, 200, server.supervisor)
    server.expect("POST", "/auth/worker-invitations/accept", {
        "token": replacement["token"], "password": "MustNotBeAccepted!",
    }, 400)
    print("ok - reissue replaces the old link and revoke prevents acceptance")


def test_pending_accounts_cannot_bypass_worker_password_setup(server):
    invitation = server.invite("pending-access@example.com")
    signed_token = jwt.encode({
        "sub": invitation["user"]["email"], "exp": datetime.now(timezone.utc) + timedelta(minutes=5),
    }, server.environment["GEO_SECRET_KEY"], algorithm="HS256")
    server.expect("GET", "/auth/me", None, 403, signed_token)
    server.expect("POST", "/auth/refresh", None, 403, signed_token)
    server.expect("PATCH", f'/supervisor/users/{invitation["user"]["id"]}', {
        "password": "SupervisorMustNotChoose!", "confirmed": True,
    }, 409, server.supervisor)
    server.expect("POST", "/auth/login", {
        "email": invitation["user"]["email"], "password": "SupervisorMustNotChoose!",
    }, 401)
    print("ok - pending accounts cannot authenticate or receive a Supervisor-chosen password")


def test_staff_changes_permanently_revoke_prior_links(server):
    invitation = server.invite("changed-invite@example.com")
    path = f'/supervisor/users/{invitation["user"]["id"]}'
    for new_email in ("changed-address@example.com", "changed-invite@example.com"):
        server.expect("PATCH", path, {"email": new_email, "confirmed": True}, 200, server.supervisor)
    server.expect("POST", "/auth/worker-invitations/inspect", {"token": invitation["token"]}, 400)
    replacement, _ = server.expect("POST", path + "/invitation", {}, 200, server.supervisor)
    for status in ("resigned", "active"):
        server.expect("POST", path + "/status", {"status": status, "confirmed": True}, 200, server.supervisor)
    server.expect("POST", "/auth/worker-invitations/inspect", {"token": replacement["token"]}, 400)
    server.expect("PATCH", path, {"role": "supervisor", "confirmed": True}, 409, server.supervisor)
    print("ok - restored email/status never revives revoked links; pending Workers cannot be promoted")


def test_invitation_responses_are_private_and_do_not_leak_through_staff_or_audit(server):
    invitation, headers = server.expect("POST", "/supervisor/worker-invitations", {
        "email": "private-invite@example.com", "name": "Private Worker",
    }, 200, server.supervisor)
    assert "no-store" in headers.get("Cache-Control", ""), "Invitation issuance must not be cached"
    for token, expected in ((invitation["token"], 200), ("invalid-token-that-is-long-enough", 400)):
        _, headers = server.expect("POST", "/auth/worker-invitations/inspect", {"token": token}, expected)
        assert "no-store" in headers.get("Cache-Control", "")
        assert headers.get("Referrer-Policy") == "no-referrer"
    for path in ("/supervisor/users", "/supervisor/audit-events"):
        result, _ = server.expect("GET", path, None, 200, server.supervisor)
        assert invitation["token"] not in json.dumps(result)
        assert "token_hash" not in json.dumps(result)
        assert "password_hash" not in json.dumps(result)
    print("ok - invitation responses are no-store and credentials never enter Staff or audit responses")


def test_scope_and_established_account_boundaries(server):
    worker, _ = server.expect("POST", "/auth/login", {"email": "worker@example.com", "password": "Passw0rd!"}, 200)
    admin, _ = server.expect("POST", "/auth/login", {"email": "admin@example.com", "password": "Passw0rd!"}, 200)
    payload = {"name": "Scope Worker", "email": "scope-worker@example.com", "department_id": 2}
    server.expect("POST", "/supervisor/worker-invitations", payload, 401)
    server.expect("POST", "/supervisor/worker-invitations", payload, 403, worker["access_token"])
    server.expect("POST", "/supervisor/worker-invitations", payload, 403, server.supervisor)
    invitation, _ = server.expect("POST", "/supervisor/worker-invitations", payload, 200, admin["access_token"])
    path = f'/supervisor/users/{invitation["user"]["id"]}/invitation'
    server.expect("POST", path, {}, 404, server.supervisor)
    server.expect("DELETE", path, None, 404, server.supervisor)
    for user_id in (worker["user"]["id"], admin["user"]["id"]):
        server.expect("POST", f"/supervisor/users/{user_id}/invitation", {}, 409, admin["access_token"])
    # Reverting a Department move must not revive a previously issued link.
    for department_id in (1, 2):
        server.expect("PATCH", path.removesuffix("/invitation"), {
            "department_id": department_id, "confirmed": True,
        }, 200, admin["access_token"])
    server.expect("POST", "/auth/worker-invitations/inspect", {"token": invitation["token"]}, 400)
    print("ok - invitation actions enforce Worker, Department and new-account boundaries")


def test_expiry_password_boundaries_and_one_time_acceptance(server):
    expired = server.invite("expired-worker@example.com")
    # Arrange time at the owned database boundary; assertions use public HTTP APIs.
    with closing(sqlite3.connect(server.database_path)) as database:
        database.execute("UPDATE workerinvitation SET expires_at = ? WHERE worker_id = ?", (
            (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat(), expired["user"]["id"],
        ))
        database.commit()
    server.expect("POST", "/auth/worker-invitations/inspect", {"token": expired["token"]}, 400)
    server.expect("POST", "/auth/worker-invitations/accept", {"token": expired["token"], "password": "ExpiredPassword!"}, 400)
    invitation = server.invite("password-boundary@example.com")
    server.expect("POST", "/auth/worker-invitations/accept", {"token": invitation["token"], "password": "short"}, 422)
    server.expect("POST", "/auth/worker-invitations/accept", {"token": invitation["token"], "password": "界" * 25}, 400)
    server.expect("POST", "/auth/worker-invitations/accept", {"token": invitation["token"], "password": "界" * 24}, 200)
    server.expect("POST", "/auth/worker-invitations/accept", {"token": invitation["token"], "password": "CannotReplacePassword!"}, 400)
    server.expect("POST", "/auth/worker-invitations/inspect", {"token": invitation["token"]}, 400)
    server.expect("POST", "/auth/login", {"email": invitation["user"]["email"], "password": "界" * 24}, 200)
    print("ok - expiry, UTF-8 password limits and one-time acceptance preserve the chosen password")


def test_concurrent_acceptance_and_reissue_are_atomic(server):
    invitation = server.invite("concurrent-accept@example.com")
    barrier = Barrier(2)
    def accept(password):
        barrier.wait(timeout=5)
        return server.request("POST", "/auth/worker-invitations/accept", {
            "token": invitation["token"], "password": password,
        })[0]
    passwords = ["ConcurrentFirstPassword!", "ConcurrentSecondPassword!"]
    with ThreadPoolExecutor(max_workers=2) as executor:
        statuses = list(executor.map(accept, passwords))
    assert sorted(statuses) == [200, 400], "Concurrent invitation acceptance must succeed once"
    winner = passwords[statuses.index(200)]
    server.expect("POST", "/auth/login", {"email": invitation["user"]["email"], "password": winner}, 200)
    invitation = server.invite("concurrent-reissue@example.com")
    barrier = Barrier(2)
    def reissue(_):
        barrier.wait(timeout=5)
        return server.request("POST", f'/supervisor/users/{invitation["user"]["id"]}/invitation', {}, server.supervisor)
    with ThreadPoolExecutor(max_workers=2) as executor:
        responses = list(executor.map(reissue, range(2)))
    assert all(status in (200, 409) for status, _, _ in responses)
    valid_links = sum(server.request("POST", "/auth/worker-invitations/inspect", {"token": body["token"]})[0] == 200
                      for status, body, _ in responses if status == 200)
    assert valid_links == 1, "Concurrent reissue must leave only one valid link"
    server.expect("POST", "/auth/worker-invitations/inspect", {"token": invitation["token"]}, 400)
    print("ok - concurrent acceptance has one winner; concurrent reissue leaves one valid invitation")


def test_invitation_expiring_while_accept_waits_for_storage_is_rejected(server):
    invitation = server.invite("expires-during-claim@example.com")
    with closing(sqlite3.connect(server.database_path)) as database:
        database.execute("UPDATE workerinvitation SET expires_at = ? WHERE worker_id = ?", (
            (datetime.now(timezone.utc) + timedelta(seconds=1)).replace(tzinfo=None).isoformat(sep=" "),
            invitation["user"]["id"],
        ))
        database.commit()
        database.execute("BEGIN IMMEDIATE")
        with ThreadPoolExecutor(max_workers=1) as executor:
            result = executor.submit(server.request, "POST", "/auth/worker-invitations/accept", {
                "token": invitation["token"], "password": "ExpiredWhileWaiting!",
            })
            time.sleep(2)
            database.commit()
            assert result.result(timeout=10)[0] == 400, "An invitation expired before its atomic claim must not be accepted"
    print("ok - invitation expiry is rechecked after waiting for the storage claim")


if __name__ == "__main__":
    with InvitationServer() as server:
        test_worker_sets_their_own_password(server)
        test_only_latest_unrevoked_invitation_can_be_used(server)
        test_pending_accounts_cannot_bypass_worker_password_setup(server)
        test_staff_changes_permanently_revoke_prior_links(server)
        test_invitation_responses_are_private_and_do_not_leak_through_staff_or_audit(server)
        test_scope_and_established_account_boundaries(server)
        test_expiry_password_boundaries_and_one_time_acceptance(server)
        test_concurrent_acceptance_and_reissue_are_atomic(server)
        test_invitation_expiring_while_accept_waits_for_storage_is_rejected(server)
    print("worker invitation tests passed")
