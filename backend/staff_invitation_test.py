"""Staff role invitations using only an owned, disposable HTTP backend."""
from contextlib import closing
from datetime import datetime, timedelta, timezone
import sqlite3
import jwt

from invitation_test import InvitationServer


def run_checks(server):
    route = "/supervisor/staff-invitations"
    auth_route = "/auth/worker-invitations"
    admin = server.expect("POST", "/auth/login", {"email": "admin@example.com", "password": "Passw0rd!"}, 200)[0]["access_token"]
    worker = server.expect("POST", "/auth/login", {"email": "worker@example.com", "password": "Passw0rd!"}, 200)[0]["access_token"]
    payload = {"name": "Synthetic staff", "email": "new-supervisor@example.invalid", "role": "supervisor"}
    server.expect("POST", route, payload, 401)
    server.expect("POST", route, payload, 403, worker)
    server.expect("POST", route, {**payload, "department_id": 2}, 403, server.supervisor)
    server.expect("POST", route, {**payload, "is_global_admin": True}, 403, server.supervisor)
    for extra in ({"role": "owner"}, {"role": "worker", "is_global_admin": True}, {"is_global_admin": "true"}, {"password": "MustNotBeUsed!"}):
        server.expect("POST", route, {**payload, **extra}, 400 if extra.get("role") == "worker" else 422, admin)
    server.expect("POST", "/supervisor/worker-invitations", payload, 422, admin)
    server.expect("POST", route, {**payload, "email": "admin@example.com"}, 409, admin)
    print("ok - existing role/Department authority, strict requests and account conflicts")

    for index, (role, global_admin, department, actor) in enumerate([
        ("worker", False, 1, server.supervisor),
        ("supervisor", False, 1, server.supervisor),
        ("supervisor", True, 1, admin),
        ("supervisor", False, 2, admin),
    ]):
        email = f"pending-{index}@example.invalid"
        invitation, headers = server.expect("POST", route, {**payload, "email": email, "role": role,
            "is_global_admin": global_admin, "department_id": department}, 200, actor)
        user = invitation["user"]
        assert user["role"] == role and user["is_global_admin"] == global_admin and user["password_setup_required"]
        assert headers.get("Cache-Control") == "private, no-store" and headers.get("Referrer-Policy") == "no-referrer"
        token = invitation["token"]
        path = f'/supervisor/users/{user["id"]}'
        inspected, _ = server.expect("POST", auth_route + "/inspect", {"token": token}, 200)
        assert inspected["role"] == role and inspected["is_global_admin"] == global_admin
        synthetic_session = jwt.encode({"sub": email, "user_id": user["id"], "auth_generation": 0,
            "exp": datetime.now(timezone.utc) + timedelta(minutes=5)}, server.environment["GEO_SECRET_KEY"], algorithm="HS256")
        for method, target in (("GET", "/auth/me"), ("POST", "/auth/refresh"), ("GET", "/supervisor/users")):
            server.expect(method, target, None, 403, synthetic_session)
        server.expect("PATCH", path, {"password": "ChosenBySupervisor!", "confirmed": True}, 409, actor)
        server.expect("PATCH", path, {"role": "worker" if role == "supervisor" else "supervisor", "confirmed": True}, 409, actor)
        server.expect("PATCH", path, {"is_global_admin": not global_admin, "confirmed": True}, 400 if role == "worker" else 409, admin)
        if global_admin or department == 2:
            for method, suffix, body in (("POST", "/invitation", {}), ("DELETE", "/invitation", None),
                                         ("POST", "/invitation/email", {"token": token})):
                server.expect(method, path + suffix, body, 403 if global_admin else 404, server.supervisor)
        for extra in ({"role": "supervisor"}, {"is_global_admin": True}, {"department_id": 2}):
            rejected, _ = server.expect("POST", auth_route + "/accept", {"token": token, "password": "SelfChosenPassword!", **extra}, 422)
            assert token not in str(rejected) and "SelfChosenPassword!" not in str(rejected)
        # Known password in isolated storage proves even a correctly authenticated pending user is denied.
        with closing(sqlite3.connect(server.database_path)) as database:
            database.execute('UPDATE "user" SET password_hash = (SELECT password_hash FROM "user" WHERE email = ?) WHERE id = ?',
                             ("worker@example.com", user["id"]))
            database.commit()
        server.expect("POST", "/auth/login", {"email": email, "password": "Passw0rd!"}, 403)
        replacement, _ = server.expect("POST", path + "/invitation", {}, 200, actor)
        server.expect("POST", auth_route + "/accept", {"token": token, "password": "SelfChosenPassword!"}, 400)
        token = replacement["token"]
        _, headers = server.expect("POST", auth_route + "/accept", {"token": token, "password": "SelfChosenPassword!"}, 200)
        assert not headers.get_all("Set-Cookie")
        server.expect("POST", auth_route + "/accept", {"token": token, "password": "ChangedPassword!"}, 400)
        accepted = server.expect("POST", "/auth/login", {"email": email, "password": "SelfChosenPassword!"}, 200)[0]
        assert accepted["user"]["role"] == role and accepted["user"]["is_global_admin"] == global_admin
        server.expect("GET", "/supervisor/users", None, 403 if role == "worker" else 200, accepted["access_token"])
        server.expect("POST", path + "/invitation", {}, 409, actor)
    print("ok - all intended roles stay inaccessible until single-use setup; no acceptance permission tampering")

    for index, mutation in enumerate(("revoked", "expired", "role", "admin", "department", "email", "resigned")):
        invitation = server.expect("POST", route, {**payload, "email": f"invalid-{index}@example.invalid"}, 200, admin)[0]
        user_id, token = invitation["user"]["id"], invitation["token"]
        path = f"/supervisor/users/{user_id}"
        if mutation == "revoked":
            server.expect("DELETE", path + "/invitation", None, 200, admin)
        elif mutation == "expired":
            with closing(sqlite3.connect(server.database_path)) as database:
                database.execute("UPDATE workerinvitation SET expires_at = ? WHERE worker_id = ?",
                    ((datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat(), user_id)); database.commit()
        elif mutation in ("role", "admin"):
            # Storage tampering simulates a stale/concurrent capability mutation: old link fails closed.
            column, value = ("role", "worker") if mutation == "role" else ("is_global_admin", 1)
            with closing(sqlite3.connect(server.database_path)) as database:
                database.execute(f'UPDATE "user" SET {column} = ? WHERE id = ?', (value, user_id)); database.commit()
        else:
            changes = {"department": {"department_id": 2}, "email": {"email": f"changed-{index}@example.invalid"}, "resigned": {"status": "resigned"}}[mutation]
            server.expect("PATCH", path, {**changes, "confirmed": True}, 200, admin)
        server.expect("POST", auth_route + "/inspect", {"token": token}, 400)
        server.expect("POST", auth_route + "/accept", {"token": token, "password": "MustNotAcceptThis!"}, 400)
    print("ok - revocation, expiry, Department/contact/status edits and changed grants invalidate privileged setup")

    # Cookie-authenticated creation still needs CSRF and does not auto-send.
    server.expect("POST", route, payload, 403, headers={"Cookie": "__session=" + admin})
    users = server.expect("GET", "/supervisor/users", None, 200, admin)[0]
    assert all(item.get("invitation_email_status") == "not_sent" for item in users)
    assert all("token_hash" not in item and "password_hash" not in item for item in users)
    print("ok - cookie CSRF guard, private metadata, and no automatic email")


if __name__ == "__main__":
    with InvitationServer() as server:
        run_checks(server)
    print("staff invitation HTTP checks passed")
