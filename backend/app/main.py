import csv
from io import StringIO
from datetime import timezone
from pathlib import Path
from typing import Optional
from uuid import uuid4

from fastapi import FastAPI, Depends, HTTPException, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from sqlmodel import Session, select

from app.config import CORS_ORIGINS, MAX_UPLOAD_BYTES, UPLOAD_DIR
from app.database import create_db_and_tables, get_session
from app.models import User, Site, AttendanceRecord, TaskLog
from app.auth import (
    hash_password,
    verify_password,
    create_access_token,
    get_current_user,
    require_supervisor
)


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

VALID_ROLES = {"worker", "supervisor"}
VALID_ATTENDANCE_STATUSES = {"pending", "approved", "rejected"}


class LoginRequest(BaseModel):
    email: str = Field(min_length=3, max_length=320)
    password: str = Field(min_length=1, max_length=72)


class RegisterRequest(BaseModel):
    email: str = Field(min_length=3, max_length=320)
    name: str = Field(min_length=1, max_length=120)
    password: str = Field(min_length=8, max_length=72)


class UserCreateRequest(BaseModel):
    email: str = Field(min_length=3, max_length=320)
    name: str = Field(min_length=1, max_length=120)
    password: str = Field(min_length=8, max_length=72)
    role: str = Field(default="worker", max_length=40)


class SiteCreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    address: Optional[str] = Field(default=None, max_length=300)
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    allowed_radius_m: int = Field(default=100, ge=10, le=5000)


class AttendanceCreate(BaseModel):
    record_type: str
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    accuracy: Optional[float] = Field(default=None, ge=0)
    site_id: Optional[int] = Field(default=None, ge=1)
    note: Optional[str] = Field(default=None, max_length=1000)
    photo_url: Optional[str] = Field(default=None, max_length=500)


class TaskLogCreate(BaseModel):
    description: str = Field(min_length=1, max_length=3000)
    site_id: Optional[int] = Field(default=None, ge=1)
    work_date: Optional[str] = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    hours_worked: Optional[float] = Field(default=None, ge=0, le=24)
    safety_notes: Optional[str] = Field(default=None, max_length=1500)
    photo_url: Optional[str] = Field(default=None, max_length=500)


class ApprovalRequest(BaseModel):
    status: str = Field(max_length=40)
    comment: Optional[str] = Field(default=None, max_length=1000)


def format_datetime(value):
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)

    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def attendance_record_response(record: AttendanceRecord, session: Session):
    worker = session.get(User, record.worker_id)
    site = session.get(Site, record.site_id) if record.site_id else None

    return {
        "id": record.id,
        "worker_id": record.worker_id,
        "worker_name": worker.name if worker else f"Worker {record.worker_id}",
        "site_id": record.site_id,
        "site_name": site.name if site else None,
        "record_type": record.record_type,
        "latitude": record.latitude,
        "longitude": record.longitude,
        "accuracy": record.accuracy,
        "note": record.note,
        "photo_url": record.photo_url,
        "status": record.status,
        "created_at": format_datetime(record.created_at),
    }


def task_log_response(log: TaskLog, session: Session):
    worker = session.get(User, log.worker_id)
    site = session.get(Site, log.site_id) if log.site_id else None

    return {
        "id": log.id,
        "worker_id": log.worker_id,
        "worker_name": worker.name if worker else f"Worker {log.worker_id}",
        "site_id": log.site_id,
        "site_name": site.name if site else None,
        "description": log.description,
        "work_date": log.work_date,
        "hours_worked": log.hours_worked,
        "safety_notes": log.safety_notes,
        "photo_url": log.photo_url,
        "status": "logged",
        "created_at": format_datetime(log.created_at),
    }


def site_response(site: Site):
    return {
        "id": site.id,
        "name": site.name,
        "address": site.address,
        "latitude": site.latitude,
        "longitude": site.longitude,
        "allowed_radius_m": site.allowed_radius_m,
    }


def upload_url(filename: str):
    return f"/uploads/{filename}"


def user_response(user: User):
    return {
        "id": user.id,
        "email": user.email,
        "name": user.name,
        "role": user.role,
    }


def validate_user_input(email: str, name: str, password: str, role: str):
    email = email.strip().lower()
    name = name.strip()
    role = role.strip().lower()

    if "@" not in email or "." not in email:
        raise HTTPException(status_code=400, detail="Enter a valid email address")
    if not name:
        raise HTTPException(status_code=400, detail="Name is required")
    if len(password) < 8:
        raise HTTPException(status_code=400, detail="Password must be at least 8 characters")
    if len(password.encode("utf-8")) > 72:
        raise HTTPException(status_code=400, detail="Password must be 72 bytes or shorter")
    if role not in VALID_ROLES:
        raise HTTPException(status_code=400, detail="Role must be worker or supervisor")

    return email, name, role


def ensure_site_exists(session: Session, site_id: Optional[int]):
    if site_id is None:
        return

    site = session.get(Site, site_id)

    if not site:
        raise HTTPException(status_code=400, detail="Site not found")


def validate_photo_url(photo_url: Optional[str]):
    if photo_url and not photo_url.startswith("/uploads/"):
        raise HTTPException(status_code=400, detail="Photo URL must come from /photo-uploads")


def normalize_site_input(data: SiteCreateRequest):
    name = data.name.strip()
    address = data.address.strip() if data.address else None

    if not name:
        raise HTTPException(status_code=400, detail="Site name is required")

    return {
        "name": name,
        "address": address,
        "latitude": data.latitude,
        "longitude": data.longitude,
        "allowed_radius_m": data.allowed_radius_m,
    }


def select_attendance_records(status: Optional[str] = None):
    statement = select(AttendanceRecord)

    if status:
        if status not in VALID_ATTENDANCE_STATUSES:
            raise HTTPException(
                status_code=400,
                detail="status must be pending, approved, or rejected"
            )
        statement = statement.where(AttendanceRecord.status == status)

    return statement.order_by(AttendanceRecord.created_at.desc())


def create_user_account(
    session: Session,
    email: str,
    name: str,
    password: str,
    role: str
):
    email, name, role = validate_user_input(email, name, password, role)
    existing_user = session.exec(
        select(User).where(User.email == email)
    ).first()

    if existing_user:
        raise HTTPException(status_code=409, detail="A user with this email already exists")

    user = User(
        email=email,
        name=name,
        password_hash=hash_password(password),
        role=role
    )
    session.add(user)
    session.commit()
    session.refresh(user)
    return user


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
            role="worker"
        )
        session.add(worker)

    if not existing_supervisor:
        supervisor = User(
            email="supervisor@example.com",
            name="Demo Supervisor",
            password_hash=hash_password("Passw0rd!"),
            role="supervisor"
        )
        session.add(supervisor)

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

    session.commit()

    return {
        "message": "Demo data created",
        "worker": "worker@example.com / Passw0rd!",
        "supervisor": "supervisor@example.com / Passw0rd!"
    }


@app.get("/sites")
def get_sites(session: Session = Depends(get_session)):
    sites = session.exec(
        select(Site).order_by(Site.name)
    ).all()

    return [
        site_response(site)
        for site in sites
    ]


@app.post("/supervisor/sites")
def create_site(
    data: SiteCreateRequest,
    supervisor: User = Depends(require_supervisor),
    session: Session = Depends(get_session)
):
    site_data = normalize_site_input(data)
    existing_site = session.exec(
        select(Site).where(Site.name == site_data["name"])
    ).first()

    if existing_site:
        raise HTTPException(status_code=409, detail="A site with this name already exists")

    site = Site(**site_data)
    session.add(site)
    session.commit()
    session.refresh(site)

    return site_response(site)


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
    user = create_user_account(
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
    users = session.exec(
        select(User).order_by(User.role, User.name)
    ).all()

    return [
        user_response(user)
        for user in users
    ]


@app.post("/supervisor/users")
def create_user(
    data: UserCreateRequest,
    supervisor: User = Depends(require_supervisor),
    session: Session = Depends(get_session)
):
    user = create_user_account(
        session=session,
        email=data.email,
        name=data.name,
        password=data.password,
        role=data.role
    )

    return user_response(user)


@app.post("/attendance")
def create_attendance(
    data: AttendanceCreate,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session)
):
    if user.role != "worker":
        raise HTTPException(status_code=403, detail="Worker only")

    if data.record_type not in ["check_in", "check_out"]:
        raise HTTPException(
            status_code=400,
            detail="record_type must be check_in or check_out"
        )

    ensure_site_exists(session, data.site_id)
    validate_photo_url(data.photo_url)

    record = AttendanceRecord(
        worker_id=user.id,
        site_id=data.site_id,
        record_type=data.record_type,
        latitude=data.latitude,
        longitude=data.longitude,
        accuracy=data.accuracy,
        note=data.note,
        photo_url=data.photo_url,
        status="pending"
    )

    session.add(record)
    session.commit()
    session.refresh(record)

    return attendance_record_response(record, session)


@app.get("/my-records")
def get_my_records(
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session)
):
    records = session.exec(
        select(AttendanceRecord)
        .where(AttendanceRecord.worker_id == user.id)
        .order_by(AttendanceRecord.created_at.desc())
    ).all()

    return [
        attendance_record_response(record, session)
        for record in records
    ]


@app.post("/task-logs")
def create_task_log(
    data: TaskLogCreate,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session)
):
    if user.role != "worker":
        raise HTTPException(status_code=403, detail="Worker only")

    ensure_site_exists(session, data.site_id)
    validate_photo_url(data.photo_url)

    log = TaskLog(
        worker_id=user.id,
        site_id=data.site_id,
        description=data.description,
        work_date=data.work_date,
        hours_worked=data.hours_worked,
        safety_notes=data.safety_notes,
        photo_url=data.photo_url
    )

    session.add(log)
    session.commit()
    session.refresh(log)

    return task_log_response(log, session)


@app.get("/my-task-logs")
def get_my_task_logs(
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session)
):
    records = session.exec(
        select(TaskLog)
        .where(TaskLog.worker_id == user.id)
        .order_by(TaskLog.created_at.desc())
    ).all()

    return [
        task_log_response(record, session)
        for record in records
    ]


@app.get("/supervisor/pending-records")
def get_pending_records(
    supervisor: User = Depends(require_supervisor),
    session: Session = Depends(get_session)
):
    records = session.exec(
        select(AttendanceRecord)
        .where(AttendanceRecord.status == "pending")
        .order_by(AttendanceRecord.created_at.desc())
    ).all()

    return [
        attendance_record_response(record, session)
        for record in records
    ]


@app.get("/supervisor/records")
def get_supervisor_records(
    status: Optional[str] = None,
    supervisor: User = Depends(require_supervisor),
    session: Session = Depends(get_session)
):
    records = session.exec(
        select_attendance_records(status)
    ).all()

    return [
        attendance_record_response(record, session)
        for record in records
    ]


@app.get("/supervisor/records/export.csv")
def export_supervisor_records_csv(
    status: Optional[str] = None,
    supervisor: User = Depends(require_supervisor),
    session: Session = Depends(get_session)
):
    records = session.exec(
        select_attendance_records(status)
    ).all()
    output = StringIO()
    writer = csv.writer(output)
    writer.writerow([
        "id",
        "worker_id",
        "worker_name",
        "site_id",
        "site_name",
        "record_type",
        "status",
        "created_at",
        "latitude",
        "longitude",
        "accuracy",
        "note",
        "photo_url",
    ])

    for record in records:
        item = attendance_record_response(record, session)
        writer.writerow([
            item["id"],
            item["worker_id"],
            item["worker_name"],
            item["site_id"],
            item["site_name"],
            item["record_type"],
            item["status"],
            item["created_at"],
            item["latitude"],
            item["longitude"],
            item["accuracy"],
            item["note"],
            item["photo_url"],
        ])

    filename = "attendance-records.csv" if not status else f"attendance-records-{status}.csv"

    return Response(
        output.getvalue(),
        media_type="text/csv",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"'
        }
    )


@app.get("/supervisor/task-logs")
def get_supervisor_task_logs(
    supervisor: User = Depends(require_supervisor),
    session: Session = Depends(get_session)
):
    records = session.exec(
        select(TaskLog).order_by(TaskLog.created_at.desc())
    ).all()

    return [
        task_log_response(record, session)
        for record in records
    ]


@app.post("/supervisor/records/{record_id}/decision")
def decide_record(
    record_id: int,
    data: ApprovalRequest,
    supervisor: User = Depends(require_supervisor),
    session: Session = Depends(get_session)
):
    if data.status not in ["approved", "rejected"]:
        raise HTTPException(
            status_code=400,
            detail="status must be approved or rejected"
        )

    record = session.get(AttendanceRecord, record_id)

    if not record:
        raise HTTPException(status_code=404, detail="Record not found")

    record.status = data.status

    session.add(record)
    session.commit()
    session.refresh(record)

    return attendance_record_response(record, session)
