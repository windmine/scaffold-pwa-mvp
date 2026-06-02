from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import Column, Text
from sqlmodel import SQLModel, Field


class User(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)

    email: str = Field(index=True, unique=True)
    name: str
    password_hash: str

    # "worker" or "supervisor"
    role: str = Field(default="worker")
    status: str = Field(default="active", index=True)


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
    distance_from_site_m: Optional[float] = None
    within_site_radius: Optional[bool] = None

    note: Optional[str] = None
    photo_url: Optional[str] = None
    client_submission_id: Optional[str] = Field(default=None, index=True)

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
    photo_urls: Optional[str] = None
    client_submission_id: Optional[str] = Field(default=None, index=True)
    status: str = Field(default="pending", index=True)

    created_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc)
    )


class TaskTemplate(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)

    worker_id: int = Field(index=True)
    site_id: Optional[int] = Field(default=None, index=True)

    name: str
    description: str
    hours_worked: Optional[float] = None
    safety_notes: Optional[str] = None

    created_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc)
    )


class WorkForm(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)

    name: str = Field(index=True)
    description: Optional[str] = None
    fields_json: str
    status: str = Field(default="active", index=True)
    created_by: Optional[int] = Field(default=None, index=True)

    created_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc)
    )


class WorkFormSubmission(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)

    form_id: int = Field(index=True)
    worker_id: int = Field(index=True)
    site_id: Optional[int] = Field(default=None, index=True)

    work_date: Optional[str] = None
    answers_json: str
    photo_urls: Optional[str] = None
    client_submission_id: Optional[str] = Field(default=None, index=True)
    status: str = Field(default="pending", index=True)

    created_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc)
    )


class AuditEvent(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)

    actor_id: int = Field(index=True)
    action: str = Field(index=True)
    entity_type: str = Field(index=True)
    entity_id: Optional[int] = Field(default=None, index=True)
    summary: Optional[str] = None
    before_json: Optional[str] = Field(default=None, sa_column=Column(Text, nullable=True))
    after_json: Optional[str] = Field(default=None, sa_column=Column(Text, nullable=True))

    created_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        index=True
    )
