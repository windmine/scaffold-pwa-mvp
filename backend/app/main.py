import asyncio
from contextlib import suppress
import json
from typing import Optional

from fastapi import FastAPI, Depends, HTTPException, Request, UploadFile, File, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from sqlalchemy import text
from sqlmodel import Session, select

from app.config import (
    AUTO_MIGRATE,
    CORS_ORIGINS,
    ENABLE_DEV_SEED,
    PRODUCTION_LIKE,
    RATE_LIMIT_AUTH_REQUESTS,
    RATE_LIMIT_AUTH_WINDOW_SECONDS,
    RATE_LIMIT_ENABLED,
    RATE_LIMIT_GENERAL_REQUESTS,
    RATE_LIMIT_GENERAL_WINDOW_SECONDS,
    RATE_LIMIT_UPLOAD_REQUESTS,
    RATE_LIMIT_UPLOAD_WINDOW_SECONDS,
)
from app.database import migrate_database, get_session
from app.models import Department, User, Site, WorkForm
from app.rate_limit import InMemoryRateLimiter, RateLimitRule
from app.schemas import (
    ApprovalRequest,
    AttendanceCreate,
    AttendanceUpdateRequest,
    SupervisorAttendanceCreate,
    RecordRestoreRequest,
    RecordTrashRequest,
    DefaultDepartmentRequest,
    LoginRequest,
    RegisterRequest,
    RegistrationStartRequest,
    RegistrationVerifyRequest,
    SiteCreateRequest,
    SiteUpdateRequest,
    TaskLogCreate,
    TaskLogUpdateRequest,
    SupervisorTaskLogCreate,
    SupervisorWorkFormSubmissionCreate,
    SupervisorWorkFormSubmissionUpdate,
    TaskTemplateCreate,
    TaskTemplateUpdate,
    TeamWorkLogCreate,
    TeamWorkLogUpdateRequest,
    UserCreateRequest,
    UserStatusRequest,
    UserUpdateRequest,
    WorkFormCreate,
    WorkFormSubmissionCreate,
    WorkFormUpdate,
)
from app.auth import (
    AUTH_COOKIE_NAME,
    CSRF_COOKIE_NAME,
    CSRF_HEADER_NAME,
    clear_auth_cookie,
    hash_password,
    verify_password,
    create_access_token,
    create_csrf_token,
    csrf_token_from_auth_cookie,
    csrf_tokens_match,
    get_current_user,
    require_supervisor,
    set_auth_cookie,
)
from app.use_cases import attendance as attendance_use_cases
from app.use_cases import audit as audit_use_cases
from app.use_cases import registration as registration_use_cases
from app.use_cases import record_trash as record_trash_use_cases
from app.use_cases import review_queue as review_queue_use_cases
from app.use_cases import staff_site_admin as staff_site_admin_use_cases
from app.use_cases import supervisor_review as supervisor_review_use_cases
from app.use_cases import task_logs as task_log_use_cases
from app.use_cases import team_work_logs as team_work_log_use_cases
from app.use_cases import work_forms as work_form_use_cases
from app.use_cases.common import (
    DEPARTMENT_NAMES,
    list_departments,
    upload_url,
    user_response,
)
from app.upload_storage import (
    UploadTooLargeError,
    UploadValidationError,
    ensure_upload_storage_ready,
    open_authorized_upload,
    store_verified_raster_upload,
)


app = FastAPI(title="Geo Management Backend")
trash_purge_task = None
rate_limiter = InMemoryRateLimiter(
    enabled=RATE_LIMIT_ENABLED,
    default_rule=RateLimitRule(
        "general",
        RATE_LIMIT_GENERAL_REQUESTS,
        RATE_LIMIT_GENERAL_WINDOW_SECONDS,
    ),
    rules=[
        RateLimitRule(
            "auth",
            RATE_LIMIT_AUTH_REQUESTS,
            RATE_LIMIT_AUTH_WINDOW_SECONDS,
            (
                "/auth/login",
                "/auth/register",
                "/auth/registration/start",
                "/auth/registration/verify",
                "/auth/refresh",
            ),
        ),
        RateLimitRule(
            "upload",
            RATE_LIMIT_UPLOAD_REQUESTS,
            RATE_LIMIT_UPLOAD_WINDOW_SECONDS,
            ("/photo-uploads",),
        ),
    ],
    exempt_paths={"/health", "/health/ready"},
)

SAFE_CSRF_METHODS = {"GET", "HEAD", "OPTIONS", "TRACE"}
CSRF_EXEMPT_PATHS = {
    "/auth/login",
    "/auth/logout",
    "/auth/register",
    "/auth/registration/start",
    "/auth/registration/verify",
    "/dev/seed",
}


@app.middleware("http")
async def strip_firebase_hosting_api_prefix(request, call_next):
    if request.scope["path"].startswith("/api/"):
        request.scope["path"] = request.scope["path"][4:]

    return await call_next(request)


@app.middleware("http")
async def enforce_rate_limits(request: Request, call_next):
    limited_response = rate_limiter.check(request)
    if limited_response:
        return limited_response

    return await call_next(request)


@app.middleware("http")
async def protect_cookie_authenticated_writes(request: Request, call_next):
    path = request.scope["path"]
    if path.startswith("/api/"):
        path = path[4:]

    if (
        request.method.upper() in SAFE_CSRF_METHODS
        or path in CSRF_EXEMPT_PATHS
        or request.headers.get("authorization")
    ):
        return await call_next(request)

    auth_cookie = request.cookies.get(AUTH_COOKIE_NAME)
    if not auth_cookie:
        return await call_next(request)

    expected_csrf_token = csrf_token_from_auth_cookie(auth_cookie)
    if not csrf_tokens_match(
        expected_csrf_token or "",
        request.cookies.get(CSRF_COOKIE_NAME),
        request.headers.get(CSRF_HEADER_NAME),
    ):
        return JSONResponse(
            {"detail": "CSRF token missing or invalid"},
            status_code=403,
        )

    return await call_next(request)


LOCAL_DEV_HOSTS = {"127.0.0.1", "::1", "localhost"}


app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


DEMO_SITES = [
    {
        "name": "Auckland Yard",
        "address": "1 Demo Road, Auckland",
        "latitude": -36.8485,
        "longitude": 174.7633,
        "allowed_radius_m": 100,
    },
    {
        "name": "CBD Tower Job",
        "address": "99 Queen Street, Auckland",
        "latitude": -36.8468,
        "longitude": 174.7660,
        "allowed_radius_m": 120,
    },
    {
        "name": "North Shore Warehouse",
        "address": "15 Harbour Lane, Auckland",
        "latitude": -36.7832,
        "longitude": 174.7631,
        "allowed_radius_m": 150,
    },
]

DEMO_WORK_FORMS = [
    {
        "name": "Daywork log form",
        "description": "General Daywork Form with repeatable teams and calculated man-hours.",
        "fields": [
            {"id": "site_details", "label": "Site details", "type": "section", "required": False},
            {"id": "client", "label": "Client", "type": "text", "required": True},
            {"id": "details", "label": "Details", "type": "section", "required": False},
            {"id": "si_number", "label": "SI number", "type": "text", "required": False},
            {"id": "building", "label": "Building", "type": "text", "required": False},
            {"id": "level", "label": "Level", "type": "text", "required": False},
            {"id": "gridline", "label": "Gridline", "type": "text", "required": False},
            {"id": "teams", "label": "Teams", "type": "repeat", "required": True, "min_rows": 1, "max_rows": 8},
            {"id": "team_name", "label": "Team", "type": "text", "required": True, "repeat": "teams"},
            {"id": "team_people", "label": "Number of people", "type": "number", "required": True, "repeat": "teams"},
            {"id": "team_time", "label": "Working time", "type": "time_range", "required": True, "repeat": "teams"},
            {"id": "team_break", "label": "Break", "type": "select", "required": True, "options": ["No break", "15 minutes", "30 minutes", "45 minutes", "1 hour"], "repeat": "teams"},
            {"id": "team_man_hours", "label": "Team man hours", "type": "formula", "formula": "team_people * (team_time - team_break)", "repeat": "teams"},
            {"id": "job_description", "label": "Job description", "type": "textarea", "required": True},
            {"id": "dimension", "label": "Dimension", "type": "textarea", "required": False},
            {"id": "site_manager_name", "label": "Site Manager Name", "type": "text", "required": False},
            {"id": "signature", "label": "Signature", "type": "signature", "required": True},
        ],
    },
    {
        "name": "Inspection form",
        "description": "Basic scaffold/site inspection checklist.",
        "fields": [
            {"id": "inspection_area", "label": "Inspection area", "type": "text", "required": True},
            {"id": "inspection_result", "label": "Inspection result", "type": "select", "required": True, "options": ["Pass", "Fail", "Needs action"]},
            {"id": "issues_found", "label": "Issues found", "type": "textarea", "required": False},
            {"id": "follow_up_required", "label": "Follow up required", "type": "checkbox", "required": False},
        ],
    },
    {
        "name": "Tool deduction form",
        "description": "Record missing/damaged tools or deductions.",
        "fields": [
            {"id": "tool_name", "label": "Tool name", "type": "text", "required": True},
            {"id": "quantity", "label": "Quantity", "type": "number", "required": True},
            {"id": "reason", "label": "Reason", "type": "select", "required": True, "options": ["Lost", "Damaged", "Returned incomplete", "Other"]},
            {"id": "notes", "label": "Notes", "type": "textarea", "required": False},
        ],
    },
]

@app.on_event("startup")
async def on_startup():
    global trash_purge_task
    if AUTO_MIGRATE:
        migrate_database()
    ensure_upload_storage_ready(verify_lifecycle=True)
    record_trash_use_cases.purge_expired_deleted_records_with_new_session()
    trash_purge_task = asyncio.create_task(
        record_trash_use_cases.run_periodic_trash_purge()
    )


@app.on_event("shutdown")
async def on_shutdown():
    global trash_purge_task
    if trash_purge_task:
        trash_purge_task.cancel()
        with suppress(asyncio.CancelledError):
            await trash_purge_task
        trash_purge_task = None


@app.get("/health")
def health():
    return {
        "status": "ok",
        "message": "Geo backend is running"
    }


@app.get("/health/ready")
def readiness(session: Session = Depends(get_session)):
    checks = {}
    details = {}

    try:
        session.connection().execute(text("SELECT 1"))
        checks["database"] = "ok"
    except Exception:
        checks["database"] = "error"

    try:
        backend = ensure_upload_storage_ready()
        checks["upload_storage"] = "ok"
        details["upload_storage"] = {"backend": backend}
    except Exception:
        checks["upload_storage"] = "error"
        details["upload_storage"] = {"backend": "unavailable"}

    if any(value != "ok" for value in checks.values()):
        raise HTTPException(
            status_code=503,
            detail={"status": "error", "checks": checks, "details": details},
        )

    return {
        "status": "ok",
        "checks": checks,
        "details": details,
    }


@app.post("/dev/seed")
def seed_demo_data(request: Request, session: Session = Depends(get_session)):
    if not ENABLE_DEV_SEED or PRODUCTION_LIKE:
        raise HTTPException(status_code=404, detail="Not found")

    client_host = request.client.host if request.client else ""
    if client_host not in LOCAL_DEV_HOSTS:
        raise HTTPException(status_code=403, detail="Demo seed is only available from localhost")

    departments_by_name = {}
    for name in DEPARTMENT_NAMES:
        department = session.exec(
            select(Department).where(Department.name == name)
        ).first()
        if not department:
            department = Department(name=name, status="active")
            session.add(department)
            session.flush()
        departments_by_name[name] = department

    leader_department = departments_by_name["Leader"]

    existing_worker = session.exec(
        select(User).where(User.email == "worker@example.com")
    ).first()

    existing_supervisor = session.exec(
        select(User).where(User.email == "supervisor@example.com")
    ).first()
    existing_super_admin = session.exec(
        select(User).where(User.email == "admin@example.com")
    ).first()

    if not existing_worker:
        worker = User(
            department_id=leader_department.id,
            email="worker@example.com",
            name="Demo Worker",
            password_hash=hash_password("Passw0rd!"),
            role="worker",
            worker_class="leader",
            status="active"
        )
        session.add(worker)
    else:
        existing_worker.department_id = existing_worker.department_id or leader_department.id
        existing_worker.status = "active"
        existing_worker.worker_class = "leader"
        session.add(existing_worker)

    if not existing_supervisor:
        supervisor = User(
            department_id=leader_department.id,
            email="supervisor@example.com",
            name="Demo Supervisor",
            password_hash=hash_password("Passw0rd!"),
            role="supervisor",
            worker_class=None,
            status="active",
            is_global_admin=False,
        )
        session.add(supervisor)
    else:
        existing_supervisor.department_id = existing_supervisor.department_id or leader_department.id
        existing_supervisor.status = "active"
        existing_supervisor.is_global_admin = False
        existing_supervisor.worker_class = None
        session.add(existing_supervisor)

    if not existing_super_admin:
        super_admin = User(
            department_id=leader_department.id,
            email="admin@example.com",
            name="Super Admin",
            password_hash=hash_password("Passw0rd!"),
            role="supervisor",
            worker_class=None,
            status="active",
            is_global_admin=True,
        )
        session.add(super_admin)
    else:
        existing_super_admin.department_id = existing_super_admin.department_id or leader_department.id
        existing_super_admin.status = "active"
        existing_super_admin.role = "supervisor"
        existing_super_admin.is_global_admin = True
        existing_super_admin.worker_class = None
        session.add(existing_super_admin)

    legacy_site = session.exec(
        select(Site).where(Site.name == "Demo Site")
    ).first()
    existing_auckland_yard = session.exec(
        select(Site).where(Site.name == "Auckland Yard")
    ).first()

    if legacy_site and not existing_auckland_yard:
        first_site = DEMO_SITES[0]
        legacy_site.name = first_site["name"]
        legacy_site.address = first_site["address"]
        legacy_site.latitude = first_site["latitude"]
        legacy_site.longitude = first_site["longitude"]
        legacy_site.allowed_radius_m = first_site["allowed_radius_m"]
        legacy_site.department_id = legacy_site.department_id or leader_department.id
        session.add(legacy_site)

    for site_data in DEMO_SITES:
        site = session.exec(
            select(Site).where(Site.name == site_data["name"])
        ).first()

        if site:
            site.address = site_data["address"]
            site.latitude = site_data["latitude"]
            site.longitude = site_data["longitude"]
            site.allowed_radius_m = site_data["allowed_radius_m"]
            site.department_id = site.department_id or leader_department.id
        else:
            site = Site(department_id=leader_department.id, **site_data)

        session.add(site)

    for form_data in DEMO_WORK_FORMS:
        form = session.exec(
            select(WorkForm).where(WorkForm.name == form_data["name"])
        ).first()
        fields_json = json.dumps(form_data["fields"])

        if form:
            try:
                existing_fields = json.loads(form.fields_json)
            except (TypeError, json.JSONDecodeError):
                existing_fields = []
            definition_changed = (
                form.description != form_data["description"]
                or existing_fields != form_data["fields"]
            )
            form.description = form_data["description"]
            form.fields_json = fields_json
            if definition_changed:
                form.definition_version = int(form.definition_version or 1) + 1
            form.status = "active"
            form.department_id = form.department_id or leader_department.id
        else:
            form = WorkForm(
                department_id=leader_department.id,
                name=form_data["name"],
                description=form_data["description"],
                fields_json=fields_json,
                definition_version=1,
                status="active"
            )

        session.add(form)

    session.commit()

    return {
        "message": "Demo data created",
        "worker": "worker@example.com / Passw0rd!",
        "supervisor": "supervisor@example.com / Passw0rd!",
        "super_admin": "admin@example.com / Passw0rd!"
    }


@app.get("/sites")
def get_sites(
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session)
):
    return staff_site_admin_use_cases.list_sites(session, user)


@app.get("/departments")
def get_departments(
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session)
):
    return list_departments(session)


@app.post("/sites")
def create_shared_site(
    data: SiteCreateRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session)
):
    return staff_site_admin_use_cases.create_site(data, user, session)


@app.post("/supervisor/sites")
def create_site(
    data: SiteCreateRequest,
    supervisor: User = Depends(require_supervisor),
    session: Session = Depends(get_session)
):
    return staff_site_admin_use_cases.create_site(data, supervisor, session)


@app.patch("/supervisor/sites/{site_id}")
def update_site(
    site_id: int,
    data: SiteUpdateRequest,
    supervisor: User = Depends(require_supervisor),
    session: Session = Depends(get_session)
):
    return staff_site_admin_use_cases.update_site(site_id, data, supervisor, session)


@app.post("/photo-uploads")
async def upload_photo(
    file: UploadFile = File(...),
    user: User = Depends(get_current_user)
):
    try:
        stored = await store_verified_raster_upload(file, uploaded_by=user.id)
    except UploadTooLargeError as error:
        raise HTTPException(status_code=413, detail=str(error))
    except UploadValidationError as error:
        raise HTTPException(status_code=400, detail=str(error))

    return {
        "url": upload_url(stored.filename),
        "filename": stored.filename,
        "content_type": stored.content_type,
        "size": stored.size,
        "width": stored.width,
        "height": stored.height,
        "uploaded_by": stored.uploaded_by,
    }


@app.get("/uploads/{filename}")
def get_upload(
    filename: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    upload = open_authorized_upload(filename, user, session)
    if not upload:
        raise HTTPException(status_code=404, detail="Upload not found")

    return StreamingResponse(
        upload.chunks,
        media_type=upload.info.content_type,
        headers={
            "Cache-Control": "private, max-age=3600",
            "Content-Length": str(upload.info.size),
            "X-Content-Type-Options": "nosniff",
        },
    )


@app.post("/auth/login")
def login(
    data: LoginRequest,
    response: Response,
    session: Session = Depends(get_session)
):
    email = data.email.strip().lower()
    user = session.exec(
        select(User).where(User.email == email)
    ).first()

    if not user or not verify_password(data.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid email or password")

    if (user.status or "active") != "active":
        raise HTTPException(status_code=403, detail="This account is resigned and cannot sign in")

    csrf_token = create_csrf_token()
    token = create_access_token({
        "sub": user.email,
        "role": user.role,
        "csrf": csrf_token,
    })
    set_auth_cookie(response, token, csrf_token)

    return {
        "access_token": token,
        "token_type": "bearer",
        "user": user_response(user, session)
    }


@app.post("/auth/register")
def register(
    data: RegisterRequest,
    session: Session = Depends(get_session)
):
    user = registration_use_cases.complete_registration(data, session)
    return {
        "user": user_response(user, session),
        "message": "Account created. A supervisor must activate it before you can sign in.",
    }


@app.post("/auth/registration/start")
def start_registration(
    data: RegistrationStartRequest,
    session: Session = Depends(get_session),
):
    return registration_use_cases.start_registration(data, session)


@app.post("/auth/registration/verify")
def verify_registration(
    data: RegistrationVerifyRequest,
    session: Session = Depends(get_session),
):
    return registration_use_cases.verify_registration(data, session)


@app.post("/auth/logout")
def logout(response: Response):
    clear_auth_cookie(response)
    return {"message": "Signed out"}


@app.post("/auth/refresh")
def refresh_session(
    response: Response,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    csrf_token = create_csrf_token()
    token = create_access_token({
        "sub": user.email,
        "role": user.role,
        "csrf": csrf_token,
    })
    set_auth_cookie(response, token, csrf_token)
    return user_response(user, session)


@app.get("/auth/me")
def me(
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    return user_response(user, session)


@app.patch("/auth/default-department")
def update_default_department(
    data: DefaultDepartmentRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    return staff_site_admin_use_cases.update_default_department(data, user, session)


@app.get("/supervisor/users")
def get_users(
    supervisor: User = Depends(require_supervisor),
    session: Session = Depends(get_session)
):
    return staff_site_admin_use_cases.list_users(session, supervisor)


@app.post("/supervisor/users")
def create_user(
    data: UserCreateRequest,
    supervisor: User = Depends(require_supervisor),
    session: Session = Depends(get_session)
):
    return staff_site_admin_use_cases.create_staff_user(data, supervisor, session)


@app.patch("/supervisor/users/{user_id}")
def update_user(
    user_id: int,
    data: UserUpdateRequest,
    supervisor: User = Depends(require_supervisor),
    session: Session = Depends(get_session)
):
    return staff_site_admin_use_cases.update_user(user_id, data, supervisor, session)


@app.post("/supervisor/users/{user_id}/status")
def update_user_status(
    user_id: int,
    data: UserStatusRequest,
    supervisor: User = Depends(require_supervisor),
    session: Session = Depends(get_session)
):
    return staff_site_admin_use_cases.update_user_status(user_id, data, supervisor, session)


@app.get("/supervisor/audit-events")
def get_supervisor_audit_events(
    limit: int = 100,
    entity_type: Optional[str] = None,
    actor_id: Optional[int] = None,
    supervisor: User = Depends(require_supervisor),
    session: Session = Depends(get_session)
):
    return audit_use_cases.list_audit_events(
        session=session,
        supervisor=supervisor,
        limit=limit,
        entity_type=entity_type,
        actor_id=actor_id,
    )


@app.post("/attendance")
def create_attendance(
    data: AttendanceCreate,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session)
):
    return attendance_use_cases.create_attendance(data, user, session)


@app.patch("/my-records/{record_id}")
def update_my_attendance_record(
    record_id: int,
    data: AttendanceUpdateRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session)
):
    return attendance_use_cases.update_my_attendance_record(record_id, data, user, session)


@app.delete("/my-records/{record_id}")
def delete_my_attendance_record(
    record_id: int,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session)
):
    return attendance_use_cases.delete_my_attendance_record(record_id, user, session)


@app.get("/my-records")
def get_my_records(
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session)
):
    return attendance_use_cases.list_my_attendance_records(user, session)


@app.post("/task-logs")
def create_task_log(
    data: TaskLogCreate,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session)
):
    return task_log_use_cases.create_task_log(data, user, session)


@app.patch("/my-task-logs/{log_id}")
def update_my_task_log(
    log_id: int,
    data: TaskLogUpdateRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session)
):
    return task_log_use_cases.update_my_task_log(log_id, user, session)


@app.delete("/my-task-logs/{log_id}")
def delete_my_task_log(
    log_id: int,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session)
):
    return task_log_use_cases.delete_my_task_log(log_id, user, session)


@app.get("/my-task-logs")
def get_my_task_logs(
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session)
):
    return task_log_use_cases.list_my_task_logs(user, session)


@app.get("/team-work-log-members")
def get_team_work_log_members(
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    return team_work_log_use_cases.list_team_members(user, session)


@app.post("/team-work-logs")
def create_team_work_log(
    data: TeamWorkLogCreate,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    return team_work_log_use_cases.create_team_work_log(data, user, session)


@app.get("/my-team-work-logs")
def get_my_team_work_logs(
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    return team_work_log_use_cases.list_my_team_work_logs(user, session)


@app.get("/supervisor/team-work-logs")
def get_supervisor_team_work_logs(
    status: Optional[str] = None,
    supervisor: User = Depends(require_supervisor),
    session: Session = Depends(get_session),
):
    return team_work_log_use_cases.list_supervisor_team_work_logs(status, supervisor, session)


@app.patch("/supervisor/team-work-logs/{log_id}")
def update_supervisor_team_work_log(
    log_id: int,
    data: TeamWorkLogUpdateRequest,
    supervisor: User = Depends(require_supervisor),
    session: Session = Depends(get_session),
):
    return supervisor_review_use_cases.update_supervisor_team_work_log(log_id, data, supervisor, session)


@app.get("/task-templates")
def get_task_templates(
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session)
):
    return task_log_use_cases.list_task_templates(user, session)


@app.post("/task-templates")
def create_task_template(
    data: TaskTemplateCreate,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session)
):
    return task_log_use_cases.create_task_template(data, user, session)


@app.patch("/task-templates/{template_id}")
def update_task_template(
    template_id: int,
    data: TaskTemplateUpdate,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session)
):
    return task_log_use_cases.update_task_template(template_id, data, user, session)


@app.delete("/task-templates/{template_id}")
def delete_task_template(
    template_id: int,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session)
):
    return task_log_use_cases.delete_task_template(template_id, user, session)


@app.get("/work-forms")
def get_work_forms(
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session)
):
    return work_form_use_cases.list_work_forms(user, session)


@app.post("/supervisor/work-forms")
def create_work_form(
    data: WorkFormCreate,
    supervisor: User = Depends(require_supervisor),
    session: Session = Depends(get_session)
):
    return work_form_use_cases.create_work_form(data, supervisor, session)


@app.patch("/supervisor/work-forms/{form_id}")
def update_work_form(
    form_id: int,
    data: WorkFormUpdate,
    supervisor: User = Depends(require_supervisor),
    session: Session = Depends(get_session)
):
    return work_form_use_cases.update_work_form(form_id, data, supervisor, session)


@app.post("/form-submissions")
def create_work_form_submission(
    data: WorkFormSubmissionCreate,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session)
):
    return work_form_use_cases.create_work_form_submission(data, user, session)


@app.post("/supervisor/form-submissions")
def create_supervisor_work_form_submission(
    data: SupervisorWorkFormSubmissionCreate,
    supervisor: User = Depends(require_supervisor),
    session: Session = Depends(get_session)
):
    return supervisor_review_use_cases.create_supervisor_work_form_submission(data, supervisor, session)


@app.get("/my-form-submissions")
def get_my_form_submissions(
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session)
):
    return work_form_use_cases.list_my_form_submissions(user, session)


@app.get("/supervisor/form-submissions")
def get_supervisor_form_submissions(
    status: Optional[str] = None,
    supervisor: User = Depends(require_supervisor),
    session: Session = Depends(get_session)
):
    return work_form_use_cases.list_supervisor_form_submissions(status, supervisor, session)


@app.get("/supervisor/review-records")
def get_supervisor_review_records(
    status: Optional[str] = None,
    supervisor: User = Depends(require_supervisor),
    session: Session = Depends(get_session)
):
    return supervisor_review_use_cases.list_review_records(session, supervisor, status)


@app.get("/supervisor/review-queue")
def get_supervisor_review_queue(
    status: Optional[str] = None,
    kind: Optional[str] = None,
    department_id: Optional[int] = None,
    record_date: Optional[str] = None,
    search: Optional[str] = None,
    cursor: Optional[str] = None,
    page_size: int = 50,
    supervisor: User = Depends(require_supervisor),
    session: Session = Depends(get_session),
):
    return review_queue_use_cases.list_review_record_page(
        session,
        supervisor,
        status=status,
        kind=kind,
        department_id=department_id,
        record_date=record_date,
        search=search,
        cursor=cursor,
        page_size=page_size,
    )


@app.get("/supervisor/pending-records")
def get_pending_records(
    supervisor: User = Depends(require_supervisor),
    session: Session = Depends(get_session)
):
    return supervisor_review_use_cases.list_pending_attendance_records(session, supervisor)


@app.get("/supervisor/records")
def get_supervisor_records(
    status: Optional[str] = None,
    supervisor: User = Depends(require_supervisor),
    session: Session = Depends(get_session)
):
    return supervisor_review_use_cases.list_supervisor_attendance_records(session, supervisor, status)


@app.post("/supervisor/records")
def create_supervisor_record(
    data: SupervisorAttendanceCreate,
    supervisor: User = Depends(require_supervisor),
    session: Session = Depends(get_session)
):
    return supervisor_review_use_cases.create_manual_attendance_record(data, supervisor, session)


@app.patch("/supervisor/records/{record_id}")
def update_supervisor_record(
    record_id: int,
    data: AttendanceUpdateRequest,
    supervisor: User = Depends(require_supervisor),
    session: Session = Depends(get_session)
):
    return supervisor_review_use_cases.update_supervisor_attendance_record(record_id, data, supervisor, session)


@app.get("/supervisor/records/export.csv")
def export_supervisor_records_csv(
    status: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    department_id: Optional[int] = None,
    supervisor: User = Depends(require_supervisor),
    session: Session = Depends(get_session)
):
    return supervisor_review_use_cases.export_attendance_records_csv(
        session,
        supervisor,
        status,
        date_from,
        date_to,
        department_id,
    )


@app.get("/supervisor/task-logs")
def get_supervisor_task_logs(
    status: Optional[str] = None,
    supervisor: User = Depends(require_supervisor),
    session: Session = Depends(get_session)
):
    return supervisor_review_use_cases.list_supervisor_task_logs(session, supervisor, status)


@app.post("/supervisor/task-logs")
def create_supervisor_task_log(
    data: SupervisorTaskLogCreate,
    supervisor: User = Depends(require_supervisor),
    session: Session = Depends(get_session)
):
    return supervisor_review_use_cases.create_supervisor_task_log(data, supervisor, session)


@app.get("/supervisor/task-logs/export.csv")
def export_supervisor_task_logs_csv(
    status: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    department_id: Optional[int] = None,
    supervisor: User = Depends(require_supervisor),
    session: Session = Depends(get_session)
):
    return supervisor_review_use_cases.export_task_logs_csv(
        session,
        supervisor,
        status,
        date_from,
        date_to,
        department_id,
    )


@app.get("/supervisor/task-logs/export.html")
def export_supervisor_task_logs_html(
    layout: str = "daily-log",
    status: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    department_id: Optional[int] = None,
    supervisor: User = Depends(require_supervisor),
    session: Session = Depends(get_session)
):
    return supervisor_review_use_cases.export_task_logs_html(
        session,
        supervisor,
        layout,
        status,
        date_from,
        date_to,
        department_id,
    )


@app.get("/supervisor/task-logs/{log_id}/export.csv")
def export_supervisor_task_log_csv(
    log_id: int,
    supervisor: User = Depends(require_supervisor),
    session: Session = Depends(get_session)
):
    return supervisor_review_use_cases.export_task_log_csv(log_id, session, supervisor)


@app.get("/supervisor/task-logs/{log_id}/export.html")
def export_supervisor_task_log_html(
    log_id: int,
    layout: str = "daily-log",
    supervisor: User = Depends(require_supervisor),
    session: Session = Depends(get_session)
):
    return supervisor_review_use_cases.export_task_log_html(log_id, session, supervisor, layout)


@app.get("/supervisor/form-submissions/export.csv")
def export_supervisor_form_submissions_csv(
    status: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    form_id: Optional[int] = None,
    department_id: Optional[int] = None,
    supervisor: User = Depends(require_supervisor),
    session: Session = Depends(get_session)
):
    return supervisor_review_use_cases.export_form_submissions_csv(
        session,
        supervisor,
        status,
        date_from,
        date_to,
        form_id,
        department_id,
    )


@app.get("/supervisor/form-submissions/export.html")
def export_supervisor_form_submissions_html(
    status: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    form_id: Optional[int] = None,
    department_id: Optional[int] = None,
    supervisor: User = Depends(require_supervisor),
    session: Session = Depends(get_session)
):
    return supervisor_review_use_cases.export_form_submissions_html(
        session,
        supervisor,
        status,
        date_from,
        date_to,
        form_id,
        department_id,
    )


@app.get("/supervisor/form-submissions/export.pdf")
def export_supervisor_form_submissions_pdf(
    template: str = "submitted-form",
    status: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    form_id: Optional[int] = None,
    department_id: Optional[int] = None,
    supervisor: User = Depends(require_supervisor),
    session: Session = Depends(get_session)
):
    return supervisor_review_use_cases.export_form_submissions_pdf(
        session,
        supervisor,
        template,
        status,
        date_from,
        date_to,
        form_id,
        department_id,
    )


@app.get("/supervisor/form-submissions/{submission_id}/export.csv")
def export_supervisor_form_submission_csv(
    submission_id: int,
    supervisor: User = Depends(require_supervisor),
    session: Session = Depends(get_session)
):
    return supervisor_review_use_cases.export_form_submission_csv(submission_id, session, supervisor)


@app.get("/supervisor/form-submissions/{submission_id}/export.html")
def export_supervisor_form_submission_html(
    submission_id: int,
    supervisor: User = Depends(require_supervisor),
    session: Session = Depends(get_session)
):
    return supervisor_review_use_cases.export_form_submission_html(submission_id, session, supervisor)


@app.get("/supervisor/form-submissions/{submission_id}/export.pdf")
def export_supervisor_form_submission_pdf(
    submission_id: int,
    template: str = "submitted-form",
    supervisor: User = Depends(require_supervisor),
    session: Session = Depends(get_session)
):
    return supervisor_review_use_cases.export_form_submission_pdf(submission_id, session, supervisor, template)


@app.patch("/supervisor/form-submissions/{submission_id}")
def update_supervisor_form_submission(
    submission_id: int,
    data: SupervisorWorkFormSubmissionUpdate,
    supervisor: User = Depends(require_supervisor),
    session: Session = Depends(get_session)
):
    return supervisor_review_use_cases.update_supervisor_form_submission(submission_id, data, supervisor, session)


@app.patch("/supervisor/task-logs/{log_id}")
def update_supervisor_task_log(
    log_id: int,
    data: TaskLogUpdateRequest,
    supervisor: User = Depends(require_supervisor),
    session: Session = Depends(get_session)
):
    return supervisor_review_use_cases.update_supervisor_task_log(log_id, data, supervisor, session)


@app.get("/supervisor/trash")
def get_supervisor_trash(
    supervisor: User = Depends(require_supervisor),
    session: Session = Depends(get_session)
):
    return record_trash_use_cases.list_trash(session, supervisor)


@app.post("/supervisor/trash/{record_type}/{record_id}")
def move_supervisor_record_to_trash(
    record_type: str,
    record_id: int,
    data: RecordTrashRequest,
    supervisor: User = Depends(require_supervisor),
    session: Session = Depends(get_session)
):
    return record_trash_use_cases.move_record_to_trash(
        record_type,
        record_id,
        data,
        supervisor,
        session,
    )


@app.post("/supervisor/trash/{record_type}/{record_id}/restore")
def restore_supervisor_record(
    record_type: str,
    record_id: int,
    data: RecordRestoreRequest,
    supervisor: User = Depends(require_supervisor),
    session: Session = Depends(get_session)
):
    return record_trash_use_cases.restore_record(
        record_type,
        record_id,
        data,
        supervisor,
        session,
    )


@app.post("/supervisor/review-records/{record_type}/{record_id}/decision")
def decide_review_record(
    record_type: str,
    record_id: int,
    data: ApprovalRequest,
    supervisor: User = Depends(require_supervisor),
    session: Session = Depends(get_session)
):
    return supervisor_review_use_cases.apply_review_decision(
        record_type,
        record_id,
        data.status,
        supervisor,
        session,
        comment=data.comment,
    )


@app.post("/supervisor/records/{record_id}/decision")
def decide_record(
    record_id: int,
    data: ApprovalRequest,
    supervisor: User = Depends(require_supervisor),
    session: Session = Depends(get_session)
):
    return supervisor_review_use_cases.apply_review_decision(
        data.record_type,
        record_id,
        data.status,
        supervisor,
        session,
        comment=data.comment,
    )
