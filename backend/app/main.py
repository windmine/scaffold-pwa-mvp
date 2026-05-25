import csv
import json
import math
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
from app.models import User, Site, AttendanceRecord, TaskLog, TaskTemplate
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
VALID_USER_STATUSES = {"active", "resigned"}
VALID_ATTENDANCE_STATUSES = {"pending", "approved", "rejected"}
MAX_TASK_LOG_PHOTOS = 8


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


class UserStatusRequest(BaseModel):
    status: str = Field(max_length=40)
    confirmed: bool = False


class SiteCreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    address: Optional[str] = Field(default=None, max_length=300)
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    allowed_radius_m: int = Field(default=100, ge=10, le=5000)


class SiteUpdateRequest(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=160)
    address: Optional[str] = Field(default=None, max_length=300)
    latitude: Optional[float] = Field(default=None, ge=-90, le=90)
    longitude: Optional[float] = Field(default=None, ge=-180, le=180)
    allowed_radius_m: Optional[int] = Field(default=None, ge=10, le=5000)
    confirmed: bool = False


class AttendanceCreate(BaseModel):
    record_type: str
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    accuracy: Optional[float] = Field(default=None, ge=0)
    site_id: Optional[int] = Field(default=None, ge=1)
    note: Optional[str] = Field(default=None, max_length=1000)
    photo_url: Optional[str] = Field(default=None, max_length=500)


class AttendanceUpdateRequest(BaseModel):
    record_type: Optional[str] = Field(default=None, max_length=40)
    latitude: Optional[float] = Field(default=None, ge=-90, le=90)
    longitude: Optional[float] = Field(default=None, ge=-180, le=180)
    accuracy: Optional[float] = Field(default=None, ge=0)
    site_id: Optional[int] = Field(default=None, ge=1)
    note: Optional[str] = Field(default=None, max_length=1000)
    photo_url: Optional[str] = Field(default=None, max_length=500)
    status: Optional[str] = Field(default=None, max_length=40)
    confirmed: bool = False


class TaskLogCreate(BaseModel):
    description: str = Field(min_length=1, max_length=3000)
    site_id: Optional[int] = Field(default=None, ge=1)
    work_date: Optional[str] = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    hours_worked: Optional[float] = Field(default=None, ge=0, le=24)
    safety_notes: Optional[str] = Field(default=None, max_length=1500)
    photo_url: Optional[str] = Field(default=None, max_length=500)
    photo_urls: list[str] = Field(default_factory=list)


class TaskLogUpdateRequest(BaseModel):
    description: Optional[str] = Field(default=None, min_length=1, max_length=3000)
    site_id: Optional[int] = Field(default=None, ge=1)
    work_date: Optional[str] = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    hours_worked: Optional[float] = Field(default=None, ge=0, le=24)
    safety_notes: Optional[str] = Field(default=None, max_length=1500)
    photo_url: Optional[str] = Field(default=None, max_length=500)
    photo_urls: Optional[list[str]] = None
    confirmed: bool = False


class TaskTemplateCreate(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    description: str = Field(min_length=1, max_length=3000)
    site_id: Optional[int] = Field(default=None, ge=1)
    hours_worked: Optional[float] = Field(default=None, ge=0, le=24)
    safety_notes: Optional[str] = Field(default=None, max_length=1500)


class TaskTemplateUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=160)
    description: Optional[str] = Field(default=None, min_length=1, max_length=3000)
    site_id: Optional[int] = Field(default=None, ge=1)
    hours_worked: Optional[float] = Field(default=None, ge=0, le=24)
    safety_notes: Optional[str] = Field(default=None, max_length=1500)


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
        "distance_from_site_m": record.distance_from_site_m,
        "within_site_radius": record.within_site_radius,
        "note": record.note,
        "photo_url": record.photo_url,
        "status": record.status,
        "created_at": format_datetime(record.created_at),
    }


def task_log_photo_urls(log: TaskLog):
    urls = []

    if log.photo_urls:
        try:
            loaded = json.loads(log.photo_urls)
            if isinstance(loaded, list):
                urls = [
                    item
                    for item in loaded
                    if isinstance(item, str) and item
                ]
        except json.JSONDecodeError:
            urls = []

    if log.photo_url and log.photo_url not in urls:
        urls.insert(0, log.photo_url)

    return urls


def task_log_response(log: TaskLog, session: Session):
    worker = session.get(User, log.worker_id)
    site = session.get(Site, log.site_id) if log.site_id else None
    photo_urls = task_log_photo_urls(log)

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
        "photo_url": photo_urls[0] if photo_urls else None,
        "photo_urls": photo_urls,
        "status": "logged",
        "created_at": format_datetime(log.created_at),
    }


def task_template_response(template: TaskTemplate, session: Session):
    site = session.get(Site, template.site_id) if template.site_id else None

    return {
        "id": template.id,
        "worker_id": template.worker_id,
        "site_id": template.site_id,
        "site_name": site.name if site else None,
        "name": template.name,
        "description": template.description,
        "hours_worked": template.hours_worked,
        "safety_notes": template.safety_notes,
        "created_at": format_datetime(template.created_at),
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
        "status": user.status or "active",
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


def require_confirmed(confirmed: bool):
    if not confirmed:
        raise HTTPException(status_code=400, detail="Double check required before saving this change")


def ensure_site_exists(session: Session, site_id: Optional[int]):
    if site_id is None:
        return None

    site = session.get(Site, site_id)

    if not site:
        raise HTTPException(status_code=400, detail="Site not found")

    return site


def distance_between_coordinates_m(
    start_latitude: float,
    start_longitude: float,
    end_latitude: float,
    end_longitude: float
):
    earth_radius_m = 6371000
    start_lat = math.radians(start_latitude)
    end_lat = math.radians(end_latitude)
    delta_lat = math.radians(end_latitude - start_latitude)
    delta_lon = math.radians(end_longitude - start_longitude)
    a = (
        math.sin(delta_lat / 2) ** 2
        + math.cos(start_lat) * math.cos(end_lat) * math.sin(delta_lon / 2) ** 2
    )
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return earth_radius_m * c


def site_distance_check(site: Optional[Site], latitude: float, longitude: float):
    if site is None:
        return None, None

    distance = round(
        distance_between_coordinates_m(
            site.latitude,
            site.longitude,
            latitude,
            longitude
        ),
        1
    )

    return distance, distance <= site.allowed_radius_m


def validate_photo_url(photo_url: Optional[str]):
    if photo_url and len(photo_url) > 500:
        raise HTTPException(status_code=400, detail="Photo URL is too long")
    if photo_url and not photo_url.startswith("/uploads/"):
        raise HTTPException(status_code=400, detail="Photo URL must come from /photo-uploads")


def normalize_task_photo_urls(
    photo_url: Optional[str] = None,
    photo_urls: Optional[list[str]] = None
):
    urls = []

    if photo_urls:
        urls.extend([url for url in photo_urls if url])
    if photo_url and photo_url not in urls:
        urls.insert(0, photo_url)

    if len(urls) > MAX_TASK_LOG_PHOTOS:
        raise HTTPException(
            status_code=400,
            detail=f"Task logs can include up to {MAX_TASK_LOG_PHOTOS} photos"
        )

    for url in urls:
        validate_photo_url(url)

    return urls


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
        role=role,
        status="active"
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


@app.patch("/supervisor/sites/{site_id}")
def update_site(
    site_id: int,
    data: SiteUpdateRequest,
    supervisor: User = Depends(require_supervisor),
    session: Session = Depends(get_session)
):
    require_confirmed(data.confirmed)
    site = session.get(Site, site_id)

    if not site:
        raise HTTPException(status_code=404, detail="Site not found")

    fields = data.model_fields_set
    if "name" in fields and data.name is not None:
        name = data.name.strip()
        if not name:
            raise HTTPException(status_code=400, detail="Site name is required")
        existing_site = session.exec(
            select(Site).where(Site.name == name, Site.id != site.id)
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


@app.post("/supervisor/users/{user_id}/status")
def update_user_status(
    user_id: int,
    data: UserStatusRequest,
    supervisor: User = Depends(require_supervisor),
    session: Session = Depends(get_session)
):
    require_confirmed(data.confirmed)
    status = data.status.strip().lower()

    if status not in VALID_USER_STATUSES:
        raise HTTPException(status_code=400, detail="status must be active or resigned")

    user = session.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    if user.id == supervisor.id and status != "active":
        raise HTTPException(status_code=400, detail="You cannot resign your own supervisor account")

    user.status = status
    session.add(user)
    session.commit()
    session.refresh(user)

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

    site = ensure_site_exists(session, data.site_id)
    validate_photo_url(data.photo_url)
    distance_from_site_m, within_site_radius = site_distance_check(
        site,
        data.latitude,
        data.longitude
    )

    record = AttendanceRecord(
        worker_id=user.id,
        site_id=data.site_id,
        record_type=data.record_type,
        latitude=data.latitude,
        longitude=data.longitude,
        accuracy=data.accuracy,
        distance_from_site_m=distance_from_site_m,
        within_site_radius=within_site_radius,
        note=data.note,
        photo_url=data.photo_url,
        status="pending"
    )

    session.add(record)
    session.commit()
    session.refresh(record)

    return attendance_record_response(record, session)


@app.patch("/my-records/{record_id}")
def update_my_attendance_record(
    record_id: int,
    data: AttendanceUpdateRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session)
):
    if user.role != "worker":
        raise HTTPException(status_code=403, detail="Worker only")

    record = session.get(AttendanceRecord, record_id)

    if not record or record.worker_id != user.id:
        raise HTTPException(status_code=404, detail="Record not found")
    if record.status != "pending":
        raise HTTPException(status_code=400, detail="Only pending attendance can be edited by the worker")

    fields = data.model_fields_set
    if "record_type" in fields and data.record_type is not None:
        if data.record_type not in ["check_in", "check_out"]:
            raise HTTPException(status_code=400, detail="record_type must be check_in or check_out")
        record.record_type = data.record_type
    if "site_id" in fields:
        ensure_site_exists(session, data.site_id)
        record.site_id = data.site_id
    if "latitude" in fields and data.latitude is not None:
        record.latitude = data.latitude
    if "longitude" in fields and data.longitude is not None:
        record.longitude = data.longitude
    if "accuracy" in fields:
        record.accuracy = data.accuracy
    if "note" in fields:
        record.note = data.note
    if "photo_url" in fields:
        validate_photo_url(data.photo_url)
        record.photo_url = data.photo_url

    site = ensure_site_exists(session, record.site_id)
    record.distance_from_site_m, record.within_site_radius = site_distance_check(
        site,
        record.latitude,
        record.longitude
    )

    session.add(record)
    session.commit()
    session.refresh(record)

    return attendance_record_response(record, session)


@app.delete("/my-records/{record_id}")
def delete_my_attendance_record(
    record_id: int,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session)
):
    if user.role != "worker":
        raise HTTPException(status_code=403, detail="Worker only")

    record = session.get(AttendanceRecord, record_id)

    if not record or record.worker_id != user.id:
        raise HTTPException(status_code=404, detail="Record not found")
    if record.status != "pending":
        raise HTTPException(status_code=400, detail="Only pending attendance can be deleted by the worker")

    session.delete(record)
    session.commit()

    return {"message": "Attendance record deleted"}


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
    photo_urls = normalize_task_photo_urls(data.photo_url, data.photo_urls)

    log = TaskLog(
        worker_id=user.id,
        site_id=data.site_id,
        description=data.description,
        work_date=data.work_date,
        hours_worked=data.hours_worked,
        safety_notes=data.safety_notes,
        photo_url=photo_urls[0] if photo_urls else None,
        photo_urls=json.dumps(photo_urls) if photo_urls else None
    )

    session.add(log)
    session.commit()
    session.refresh(log)

    return task_log_response(log, session)


@app.patch("/my-task-logs/{log_id}")
def update_my_task_log(
    log_id: int,
    data: TaskLogUpdateRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session)
):
    if user.role != "worker":
        raise HTTPException(status_code=403, detail="Worker only")

    log = session.get(TaskLog, log_id)

    if not log or log.worker_id != user.id:
        raise HTTPException(status_code=404, detail="Task log not found")

    raise HTTPException(status_code=403, detail="Submitted task logs cannot be edited by workers")


@app.delete("/my-task-logs/{log_id}")
def delete_my_task_log(
    log_id: int,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session)
):
    if user.role != "worker":
        raise HTTPException(status_code=403, detail="Worker only")

    log = session.get(TaskLog, log_id)

    if not log or log.worker_id != user.id:
        raise HTTPException(status_code=404, detail="Task log not found")

    raise HTTPException(status_code=403, detail="Submitted task logs cannot be deleted by workers")


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


@app.get("/task-templates")
def get_task_templates(
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session)
):
    if user.role != "worker":
        raise HTTPException(status_code=403, detail="Worker only")

    templates = session.exec(
        select(TaskTemplate)
        .where(TaskTemplate.worker_id == user.id)
        .order_by(TaskTemplate.name)
    ).all()

    return [
        task_template_response(template, session)
        for template in templates
    ]


@app.post("/task-templates")
def create_task_template(
    data: TaskTemplateCreate,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session)
):
    if user.role != "worker":
        raise HTTPException(status_code=403, detail="Worker only")

    ensure_site_exists(session, data.site_id)
    template = TaskTemplate(
        worker_id=user.id,
        site_id=data.site_id,
        name=data.name.strip(),
        description=data.description,
        hours_worked=data.hours_worked,
        safety_notes=data.safety_notes
    )
    session.add(template)
    session.commit()
    session.refresh(template)

    return task_template_response(template, session)


@app.patch("/task-templates/{template_id}")
def update_task_template(
    template_id: int,
    data: TaskTemplateUpdate,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session)
):
    if user.role != "worker":
        raise HTTPException(status_code=403, detail="Worker only")

    template = session.get(TaskTemplate, template_id)
    if not template or template.worker_id != user.id:
        raise HTTPException(status_code=404, detail="Task template not found")

    fields = data.model_fields_set
    if "name" in fields and data.name is not None:
        template.name = data.name.strip()
    if "description" in fields and data.description is not None:
        template.description = data.description
    if "site_id" in fields:
        ensure_site_exists(session, data.site_id)
        template.site_id = data.site_id
    if "hours_worked" in fields:
        template.hours_worked = data.hours_worked
    if "safety_notes" in fields:
        template.safety_notes = data.safety_notes

    session.add(template)
    session.commit()
    session.refresh(template)

    return task_template_response(template, session)


@app.delete("/task-templates/{template_id}")
def delete_task_template(
    template_id: int,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session)
):
    if user.role != "worker":
        raise HTTPException(status_code=403, detail="Worker only")

    template = session.get(TaskTemplate, template_id)
    if not template or template.worker_id != user.id:
        raise HTTPException(status_code=404, detail="Task template not found")

    session.delete(template)
    session.commit()

    return {"message": "Task template deleted"}


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


@app.patch("/supervisor/records/{record_id}")
def update_supervisor_record(
    record_id: int,
    data: AttendanceUpdateRequest,
    supervisor: User = Depends(require_supervisor),
    session: Session = Depends(get_session)
):
    require_confirmed(data.confirmed)
    record = session.get(AttendanceRecord, record_id)

    if not record:
        raise HTTPException(status_code=404, detail="Record not found")

    fields = data.model_fields_set

    if "record_type" in fields and data.record_type is not None:
        if data.record_type not in ["check_in", "check_out"]:
            raise HTTPException(status_code=400, detail="record_type must be check_in or check_out")
        record.record_type = data.record_type
    if "site_id" in fields:
        ensure_site_exists(session, data.site_id)
        record.site_id = data.site_id
    if "latitude" in fields and data.latitude is not None:
        record.latitude = data.latitude
    if "longitude" in fields and data.longitude is not None:
        record.longitude = data.longitude
    if "accuracy" in fields:
        record.accuracy = data.accuracy
    if "note" in fields:
        record.note = data.note
    if "photo_url" in fields:
        validate_photo_url(data.photo_url)
        record.photo_url = data.photo_url
    if "status" in fields and data.status is not None:
        if data.status not in VALID_ATTENDANCE_STATUSES:
            raise HTTPException(status_code=400, detail="status must be pending, approved, or rejected")
        record.status = data.status

    site = ensure_site_exists(session, record.site_id)
    record.distance_from_site_m, record.within_site_radius = site_distance_check(
        site,
        record.latitude,
        record.longitude
    )

    session.add(record)
    session.commit()
    session.refresh(record)

    return attendance_record_response(record, session)


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
        "distance_from_site_m",
        "within_site_radius",
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
            item["distance_from_site_m"],
            item["within_site_radius"],
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


@app.patch("/supervisor/task-logs/{log_id}")
def update_supervisor_task_log(
    log_id: int,
    data: TaskLogUpdateRequest,
    supervisor: User = Depends(require_supervisor),
    session: Session = Depends(get_session)
):
    require_confirmed(data.confirmed)
    log = session.get(TaskLog, log_id)

    if not log:
        raise HTTPException(status_code=404, detail="Task log not found")

    fields = data.model_fields_set
    if "description" in fields and data.description is not None:
        log.description = data.description
    if "site_id" in fields:
        ensure_site_exists(session, data.site_id)
        log.site_id = data.site_id
    if "work_date" in fields:
        log.work_date = data.work_date
    if "hours_worked" in fields:
        log.hours_worked = data.hours_worked
    if "safety_notes" in fields:
        log.safety_notes = data.safety_notes
    if "photo_urls" in fields:
        photo_urls = normalize_task_photo_urls(None, data.photo_urls or [])
        log.photo_url = photo_urls[0] if photo_urls else None
        log.photo_urls = json.dumps(photo_urls) if photo_urls else None
    elif "photo_url" in fields:
        validate_photo_url(data.photo_url)
        log.photo_url = data.photo_url
        log.photo_urls = json.dumps([data.photo_url]) if data.photo_url else None

    session.add(log)
    session.commit()
    session.refresh(log)

    return task_log_response(log, session)


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
