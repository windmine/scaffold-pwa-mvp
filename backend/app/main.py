import json
from pathlib import Path
from typing import Optional
from uuid import uuid4

from fastapi import FastAPI, Depends, HTTPException, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from sqlmodel import Session, select

from app.config import CORS_ORIGINS, MAX_UPLOAD_BYTES, UPLOAD_DIR
from app.database import create_db_and_tables, get_session
from app.models import User, Site, WorkForm
from app.schemas import (
    ApprovalRequest,
    AttendanceCreate,
    AttendanceUpdateRequest,
    LoginRequest,
    RegisterRequest,
    SiteCreateRequest,
    SiteUpdateRequest,
    TaskLogCreate,
    TaskLogUpdateRequest,
    TaskTemplateCreate,
    TaskTemplateUpdate,
    UserCreateRequest,
    UserStatusRequest,
    UserUpdateRequest,
    WorkFormCreate,
    WorkFormSubmissionCreate,
    WorkFormUpdate,
)
from app.auth import (
    hash_password,
    verify_password,
    create_access_token,
    get_current_user,
    require_supervisor
)
from app.use_cases import attendance as attendance_use_cases
from app.use_cases import staff_site_admin as staff_site_admin_use_cases
from app.use_cases import supervisor_review as supervisor_review_use_cases
from app.use_cases import task_logs as task_log_use_cases
from app.use_cases import work_forms as work_form_use_cases
from app.use_cases.common import upload_url, user_response


app = FastAPI(title="Geo Management Backend")

UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
ALLOWED_IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif"}

app.mount("/uploads", StaticFiles(directory=str(UPLOAD_DIR)), name="uploads")


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
        "description": "Daily work summary for site activity.",
        "fields": [
            {"id": "work_completed", "label": "Work completed", "type": "textarea", "required": True},
            {"id": "hours_worked", "label": "Hours worked", "type": "number", "required": True},
            {"id": "materials_used", "label": "Materials used", "type": "textarea", "required": False},
            {"id": "safety_notes", "label": "Safety notes", "type": "textarea", "required": False},
            {"id": "worker_signature", "label": "Worker signature", "type": "signature", "required": True},
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
def on_startup():
    create_db_and_tables()


@app.get("/health")
def health():
    return {
        "status": "ok",
        "message": "Geo backend is running"
    }


@app.post("/dev/seed")
def seed_demo_data(session: Session = Depends(get_session)):
    existing_worker = session.exec(
        select(User).where(User.email == "worker@example.com")
    ).first()

    existing_supervisor = session.exec(
        select(User).where(User.email == "supervisor@example.com")
    ).first()

    if not existing_worker:
        worker = User(
            email="worker@example.com",
            name="Demo Worker",
            password_hash=hash_password("Passw0rd!"),
            role="worker",
            status="active"
        )
        session.add(worker)
    else:
        existing_worker.status = "active"
        session.add(existing_worker)

    if not existing_supervisor:
        supervisor = User(
            email="supervisor@example.com",
            name="Demo Supervisor",
            password_hash=hash_password("Passw0rd!"),
            role="supervisor",
            status="active"
        )
        session.add(supervisor)
    else:
        existing_supervisor.status = "active"
        session.add(existing_supervisor)

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
        else:
            site = Site(**site_data)

        session.add(site)

    for form_data in DEMO_WORK_FORMS:
        form = session.exec(
            select(WorkForm).where(WorkForm.name == form_data["name"])
        ).first()
        fields_json = json.dumps(form_data["fields"])

        if form:
            form.description = form_data["description"]
            form.fields_json = fields_json
            form.status = "active"
        else:
            form = WorkForm(
                name=form_data["name"],
                description=form_data["description"],
                fields_json=fields_json,
                status="active"
            )

        session.add(form)

    session.commit()

    return {
        "message": "Demo data created",
        "worker": "worker@example.com / Passw0rd!",
        "supervisor": "supervisor@example.com / Passw0rd!"
    }


@app.get("/sites")
def get_sites(session: Session = Depends(get_session)):
    return staff_site_admin_use_cases.list_sites(session)


@app.post("/supervisor/sites")
def create_site(
    data: SiteCreateRequest,
    supervisor: User = Depends(require_supervisor),
    session: Session = Depends(get_session)
):
    return staff_site_admin_use_cases.create_site(data, session)


@app.patch("/supervisor/sites/{site_id}")
def update_site(
    site_id: int,
    data: SiteUpdateRequest,
    supervisor: User = Depends(require_supervisor),
    session: Session = Depends(get_session)
):
    return staff_site_admin_use_cases.update_site(site_id, data, session)


@app.post("/photo-uploads")
async def upload_photo(
    file: UploadFile = File(...),
    user: User = Depends(get_current_user)
):
    if not file.content_type or not file.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="Only image uploads are allowed")

    suffix = Path(file.filename or "").suffix.lower()
    if suffix not in ALLOWED_IMAGE_SUFFIXES:
        suffix = ".jpg"

    contents = await file.read()
    if len(contents) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="Photo must be 5MB or smaller")

    filename = f"{uuid4().hex}{suffix}"
    path = UPLOAD_DIR / filename
    path.write_bytes(contents)

    return {
        "url": upload_url(filename),
        "filename": filename,
        "content_type": file.content_type,
        "size": len(contents),
        "uploaded_by": user.id,
    }


@app.post("/auth/login")
def login(data: LoginRequest, session: Session = Depends(get_session)):
    email = data.email.strip().lower()
    user = session.exec(
        select(User).where(User.email == email)
    ).first()

    if not user or not verify_password(data.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid email or password")

    if (user.status or "active") != "active":
        raise HTTPException(status_code=403, detail="This account is resigned and cannot sign in")

    token = create_access_token({
        "sub": user.email,
        "role": user.role
    })

    return {
        "access_token": token,
        "token_type": "bearer",
        "user": user_response(user)
    }


@app.post("/auth/register")
def register(data: RegisterRequest, session: Session = Depends(get_session)):
    user = staff_site_admin_use_cases.create_user_account(
        session=session,
        email=data.email,
        name=data.name,
        password=data.password,
        role="worker"
    )
    token = create_access_token({
        "sub": user.email,
        "role": user.role
    })

    return {
        "access_token": token,
        "token_type": "bearer",
        "user": user_response(user)
    }


@app.get("/auth/me")
def me(user: User = Depends(get_current_user)):
    return user_response(user)


@app.get("/supervisor/users")
def get_users(
    supervisor: User = Depends(require_supervisor),
    session: Session = Depends(get_session)
):
    return staff_site_admin_use_cases.list_users(session)


@app.post("/supervisor/users")
def create_user(
    data: UserCreateRequest,
    supervisor: User = Depends(require_supervisor),
    session: Session = Depends(get_session)
):
    return staff_site_admin_use_cases.create_staff_user(data, session)


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
    return work_form_use_cases.update_work_form(form_id, data, session)


@app.post("/form-submissions")
def create_work_form_submission(
    data: WorkFormSubmissionCreate,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session)
):
    return work_form_use_cases.create_work_form_submission(data, user, session)


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
    return work_form_use_cases.list_supervisor_form_submissions(status, session)


@app.get("/supervisor/review-records")
def get_supervisor_review_records(
    status: Optional[str] = None,
    supervisor: User = Depends(require_supervisor),
    session: Session = Depends(get_session)
):
    return supervisor_review_use_cases.list_review_records(session, status)


@app.get("/supervisor/pending-records")
def get_pending_records(
    supervisor: User = Depends(require_supervisor),
    session: Session = Depends(get_session)
):
    return supervisor_review_use_cases.list_pending_attendance_records(session)


@app.get("/supervisor/records")
def get_supervisor_records(
    status: Optional[str] = None,
    supervisor: User = Depends(require_supervisor),
    session: Session = Depends(get_session)
):
    return supervisor_review_use_cases.list_supervisor_attendance_records(session, status)


@app.patch("/supervisor/records/{record_id}")
def update_supervisor_record(
    record_id: int,
    data: AttendanceUpdateRequest,
    supervisor: User = Depends(require_supervisor),
    session: Session = Depends(get_session)
):
    return supervisor_review_use_cases.update_supervisor_attendance_record(record_id, data, session)


@app.get("/supervisor/records/export.csv")
def export_supervisor_records_csv(
    status: Optional[str] = None,
    supervisor: User = Depends(require_supervisor),
    session: Session = Depends(get_session)
):
    return supervisor_review_use_cases.export_attendance_records_csv(session, status)


@app.get("/supervisor/task-logs")
def get_supervisor_task_logs(
    status: Optional[str] = None,
    supervisor: User = Depends(require_supervisor),
    session: Session = Depends(get_session)
):
    return supervisor_review_use_cases.list_supervisor_task_logs(session, status)


@app.get("/supervisor/task-logs/export.csv")
def export_supervisor_task_logs_csv(
    status: Optional[str] = None,
    supervisor: User = Depends(require_supervisor),
    session: Session = Depends(get_session)
):
    return supervisor_review_use_cases.export_task_logs_csv(session, status)


@app.patch("/supervisor/task-logs/{log_id}")
def update_supervisor_task_log(
    log_id: int,
    data: TaskLogUpdateRequest,
    supervisor: User = Depends(require_supervisor),
    session: Session = Depends(get_session)
):
    return supervisor_review_use_cases.update_supervisor_task_log(log_id, data, session)


@app.post("/supervisor/review-records/{record_type}/{record_id}/decision")
def decide_review_record(
    record_type: str,
    record_id: int,
    data: ApprovalRequest,
    supervisor: User = Depends(require_supervisor),
    session: Session = Depends(get_session)
):
    return supervisor_review_use_cases.apply_review_decision(record_type, record_id, data.status, session)


@app.post("/supervisor/records/{record_id}/decision")
def decide_record(
    record_id: int,
    data: ApprovalRequest,
    supervisor: User = Depends(require_supervisor),
    session: Session = Depends(get_session)
):
    return supervisor_review_use_cases.apply_review_decision(data.record_type, record_id, data.status, session)
