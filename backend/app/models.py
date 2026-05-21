from datetime import datetime, timezone
from typing import Optional

from sqlmodel import SQLModel, Field


class User(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)

    email: str = Field(index=True, unique=True)
    name: str
    password_hash: str

    # "worker" or "supervisor"
    role: str = Field(default="worker")


class Site(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)

    name: str
    address: Optional[str] = None
    latitude: float
    longitude: float

    # allowed check-in radius
    allowed_radius_m: int = 100


class AttendanceRecord(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)

    worker_id: int = Field(index=True)
    site_id: Optional[int] = Field(default=None, index=True)

    # "check_in" or "check_out"
    record_type: str

    latitude: float
    longitude: float
    accuracy: Optional[float] = None

    note: Optional[str] = None
    photo_url: Optional[str] = None

    # "pending", "approved", "rejected"
    status: str = Field(default="pending")

    created_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc)
    )


class TaskLog(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)

    worker_id: int = Field(index=True)
    site_id: Optional[int] = Field(default=None, index=True)

    description: str
    work_date: Optional[str] = None
    hours_worked: Optional[float] = None
    safety_notes: Optional[str] = None
    photo_url: Optional[str] = None

    created_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc)
    )
