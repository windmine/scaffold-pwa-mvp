from typing import Optional

from fastapi import FastAPI, Depends, HTTPException, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from sqlmodel import Session, select

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


app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "https://localhost:5173",
        "http://127.0.0.1:5173",
        "https://127.0.0.1:5173",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class LoginRequest(BaseModel):
    email: str
    password: str


class AttendanceCreate(BaseModel):
    record_type: str
    latitude: float
    longitude: float
    accuracy: Optional[float] = None
    site_id: Optional[int] = None
    note: Optional[str] = None
    photo_url: Optional[str] = None


class TaskLogCreate(BaseModel):
    description: str
    site_id: Optional[int] = None
    photo_url: Optional[str] = None


class ApprovalRequest(BaseModel):
    status: str
    comment: Optional[str] = None


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

    existing_site = session.exec(
        select(Site).where(Site.name == "Demo Site")
    ).first()

    if not existing_site:
        site = Site(
            name="Demo Site",
            address="Auckland",
            latitude=-36.8485,
            longitude=174.7633,
            allowed_radius_m=100
        )
        session.add(site)

    session.commit()

    return {
        "message": "Demo data created",
        "worker": "worker@example.com / Passw0rd!",
        "supervisor": "supervisor@example.com / Passw0rd!"
    }


@app.post("/auth/login")
def login(data: LoginRequest, session: Session = Depends(get_session)):
    user = session.exec(
        select(User).where(User.email == data.email)
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
        "user": {
            "id": user.id,
            "email": user.email,
            "name": user.name,
            "role": user.role
        }
    }


@app.get("/auth/me")
def me(user: User = Depends(get_current_user)):
    return {
        "id": user.id,
        "email": user.email,
        "name": user.name,
        "role": user.role
    }


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

    return record


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

    return records


@app.post("/task-logs")
def create_task_log(
    data: TaskLogCreate,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session)
):
    if user.role != "worker":
        raise HTTPException(status_code=403, detail="Worker only")

    log = TaskLog(
        worker_id=user.id,
        site_id=data.site_id,
        description=data.description,
        photo_url=data.photo_url
    )

    session.add(log)
    session.commit()
    session.refresh(log)

    return log


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

    return records


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

    return record