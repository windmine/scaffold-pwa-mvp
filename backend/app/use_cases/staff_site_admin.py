from fastapi import HTTPException
from sqlmodel import Session, select

from app.auth import hash_password
from app.models import Site, User
from app.use_cases.audit import add_audit_event, model_snapshot
from app.use_cases.common import (
    VALID_ROLES,
    VALID_USER_STATUSES,
    can_access_department,
    department_id_for_new_record,
    ensure_department_exists,
    normalize_site_input,
    require_confirmed,
    scope_statement_to_user_department,
    site_response,
    user_is_global_admin,
    user_response,
    validate_user_input,
)


def list_sites(session: Session, user: User):
    department_id_for_new_record(user, session)
    statement = scope_statement_to_user_department(select(Site), Site, user)
    sites = session.exec(
        statement.order_by(Site.name)
    ).all()

    return [
        site_response(site)
        for site in sites
    ]


def create_site(data, supervisor: User, session: Session):
    site_data = normalize_site_input(data)
    department_id = department_id_for_new_record(supervisor, session)
    existing_site = session.exec(
        select(Site).where(
            Site.name == site_data["name"],
            Site.department_id == department_id,
        )
    ).first()

    if existing_site:
        raise HTTPException(status_code=409, detail="A site with this name already exists")

    site = Site(department_id=department_id, **site_data)
    session.add(site)
    session.flush()
    add_audit_event(
        session=session,
        actor=supervisor,
        action="site_create",
        entity_type="site",
        entity_id=site.id,
        after=model_snapshot(site),
        summary=f"Created site {site.name}",
    )
    session.commit()
    session.refresh(site)

    return site_response(site)


def update_site(site_id: int, data, supervisor: User, session: Session):
    require_confirmed(data.confirmed)
    site = session.get(Site, site_id)

    if not site:
        raise HTTPException(status_code=404, detail="Site not found")
    if not can_access_department(supervisor, site.department_id):
        raise HTTPException(status_code=404, detail="Site not found")

    fields = data.model_fields_set
    before = model_snapshot(site)
    if "name" in fields and data.name is not None:
        name = data.name.strip()
        if not name:
            raise HTTPException(status_code=400, detail="Site name is required")
        existing_site = session.exec(
            select(Site).where(
                Site.name == name,
                Site.department_id == site.department_id,
                Site.id != site.id,
            )
        ).first()
        if existing_site:
            raise HTTPException(status_code=409, detail="A site with this name already exists")
        site.name = name
    if "address" in fields:
        site.address = data.address.strip() if data.address else None
    if "latitude" in fields and data.latitude is not None:
        site.latitude = data.latitude
    if "longitude" in fields and data.longitude is not None:
        site.longitude = data.longitude
    if "allowed_radius_m" in fields and data.allowed_radius_m is not None:
        site.allowed_radius_m = data.allowed_radius_m

    session.add(site)
    add_audit_event(
        session=session,
        actor=supervisor,
        action="site_update",
        entity_type="site",
        entity_id=site.id,
        before=before,
        after=model_snapshot(site),
        summary=f"Updated site {site.name}",
    )
    session.commit()
    session.refresh(site)

    return site_response(site)


def list_users(session: Session, supervisor: User):
    department_id_for_new_record(supervisor, session)
    statement = scope_statement_to_user_department(select(User), User, supervisor)
    users = session.exec(
        statement.order_by(User.role, User.name)
    ).all()

    return [
        user_response(user, session)
        for user in users
    ]


def create_user_account(
    session: Session,
    email: str,
    name: str,
    password: str,
    role: str,
    department_id: int | None = None,
    is_global_admin: bool = False,
):
    email, name, role = validate_user_input(email, name, password, role)
    existing_user = session.exec(
        select(User).where(User.email == email)
    ).first()

    if existing_user:
        raise HTTPException(status_code=409, detail="A user with this email already exists")

    department = ensure_department_exists(session, department_id)
    user = User(
        department_id=department.id,
        email=email,
        name=name,
        password_hash=hash_password(password),
        role=role,
        status="active",
        is_global_admin=is_global_admin,
    )
    session.add(user)
    session.commit()
    session.refresh(user)
    return user


def create_staff_user(data, supervisor: User, session: Session):
    supervisor_department_id = department_id_for_new_record(supervisor, session)
    if (
        data.department_id
        and not user_is_global_admin(supervisor)
        and data.department_id != supervisor_department_id
    ):
        raise HTTPException(status_code=403, detail="Only global admins can choose another department")
    target_department_id = (
        data.department_id
        if user_is_global_admin(supervisor) and data.department_id
        else supervisor_department_id
    )
    user = create_user_account(
        session=session,
        email=data.email,
        name=data.name,
        password=data.password,
        role=data.role,
        department_id=target_department_id,
        is_global_admin=data.is_global_admin if user_is_global_admin(supervisor) else False,
    )
    add_audit_event(
        session=session,
        actor=supervisor,
        action="user_create",
        entity_type="user",
        entity_id=user.id,
        after=model_snapshot(user),
        summary=f"Created {user.role} user {user.email}",
    )
    session.commit()

    return user_response(user, session)


def update_user(user_id: int, data, supervisor: User, session: Session):
    require_confirmed(data.confirmed)
    user = session.get(User, user_id)

    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if not can_access_department(supervisor, user.department_id):
        raise HTTPException(status_code=404, detail="User not found")

    fields = data.model_fields_set
    before = model_snapshot(user)
    changed_fields = sorted(field for field in fields if field != "confirmed")

    if "email" in fields and data.email is not None:
        email = data.email.strip().lower()
        if "@" not in email:
            raise HTTPException(status_code=400, detail="Enter a valid email address")
        existing = session.exec(
            select(User).where(User.email == email)
        ).first()
        if existing and existing.id != user.id:
            raise HTTPException(status_code=409, detail="A user with this email already exists")
        if user.id == supervisor.id and email != user.email:
            raise HTTPException(status_code=400, detail="Sign out and use another supervisor to change your own email")
        user.email = email

    if "name" in fields and data.name is not None:
        name = data.name.strip()
        if not name:
            raise HTTPException(status_code=400, detail="Name is required")
        user.name = name

    if "role" in fields and data.role is not None:
        role = data.role.strip().lower()
        if role not in VALID_ROLES:
            raise HTTPException(status_code=400, detail="Role must be worker or supervisor")
        if user.id == supervisor.id and role != "supervisor":
            raise HTTPException(status_code=400, detail="You cannot remove your own supervisor role")
        user.role = role

    if "status" in fields and data.status is not None:
        status = data.status.strip().lower()
        if status not in VALID_USER_STATUSES:
            raise HTTPException(status_code=400, detail="status must be active or resigned")
        if user.id == supervisor.id and status != "active":
            raise HTTPException(status_code=400, detail="You cannot resign your own supervisor account")
        user.status = status

    if "department_id" in fields and data.department_id is not None:
        if not user_is_global_admin(supervisor):
            if data.department_id != user.department_id:
                raise HTTPException(status_code=403, detail="Only global admins can move users between departments")
        else:
            department = ensure_department_exists(session, data.department_id)
            user.department_id = department.id

    if "is_global_admin" in fields and data.is_global_admin is not None:
        if not user_is_global_admin(supervisor):
            if data.is_global_admin != user.is_global_admin:
                raise HTTPException(status_code=403, detail="Only global admins can change global admin access")
        else:
            if user.id == supervisor.id and data.is_global_admin is False:
                raise HTTPException(status_code=400, detail="You cannot remove your own global admin access")
            user.is_global_admin = data.is_global_admin

    if "password" in fields and data.password:
        if len(data.password.encode("utf-8")) > 72:
            raise HTTPException(status_code=400, detail="Password must be 72 bytes or shorter")
        user.password_hash = hash_password(data.password)

    session.add(user)
    add_audit_event(
        session=session,
        actor=supervisor,
        action="user_update",
        entity_type="user",
        entity_id=user.id,
        before=before,
        after=model_snapshot(user),
        summary=f"Updated user {user.email}: {', '.join(changed_fields) or 'details'}",
    )
    session.commit()
    session.refresh(user)

    return user_response(user, session)


def update_user_status(user_id: int, data, supervisor: User, session: Session):
    require_confirmed(data.confirmed)
    status = data.status.strip().lower()

    if status not in VALID_USER_STATUSES:
        raise HTTPException(status_code=400, detail="status must be active or resigned")

    user = session.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if not can_access_department(supervisor, user.department_id):
        raise HTTPException(status_code=404, detail="User not found")

    if user.id == supervisor.id and status != "active":
        raise HTTPException(status_code=400, detail="You cannot resign your own supervisor account")

    before = model_snapshot(user)
    user.status = status
    session.add(user)
    add_audit_event(
        session=session,
        actor=supervisor,
        action="user_status",
        entity_type="user",
        entity_id=user.id,
        before=before,
        after=model_snapshot(user),
        summary=f"Set user {user.email} status to {status}",
    )
    session.commit()
    session.refresh(user)

    return user_response(user, session)
