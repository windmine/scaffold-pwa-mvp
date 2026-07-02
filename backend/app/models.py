from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import Column, Text
from sqlmodel import SQLModel, Field


class Department(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)

    name: str = Field(index=True, unique=True)
    status: str = Field(default="active", index=True)

    created_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc)
    )


class User(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)

    department_id: Optional[int] = Field(default=None, index=True)
    dashboard_department_id: Optional[int] = Field(default=None, index=True)
    email: str = Field(index=True, unique=True)
    name: str
    password_hash: str

    # "worker" or "supervisor"
    role: str = Field(default="worker")
    # Worker capability: "normal" or "leader". Supervisors do not use this field.
    worker_class: Optional[str] = Field(default="normal", index=True)
    status: str = Field(default="active", index=True)
    is_global_admin: bool = Field(default=False, index=True)


class RegistrationVerification(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)

    email: str = Field(index=True)
    name: str
    code_hash: str
    token_hash: Optional[str] = Field(default=None, index=True)
    attempts: int = Field(default=0)

    expires_at: datetime = Field(index=True)
    verified_at: Optional[datetime] = None
    consumed_at: Optional[datetime] = None
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        index=True,
    )


class Site(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)

    department_id: Optional[int] = Field(default=None, index=True)
    name: str
    address: Optional[str] = None
    latitude: float
    longitude: float

    # allowed check-in radius
    allowed_radius_m: int = 100


class AttendanceRecord(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)

    department_id: Optional[int] = Field(default=None, index=True)
    worker_id: int = Field(index=True)
    site_id: Optional[int] = Field(default=None, index=True)

    # "check_in" or "check_out"
    record_type: str

    latitude: Optional[float] = None
    longitude: Optional[float] = None
    accuracy: Optional[float] = None
    distance_from_site_m: Optional[float] = None
    within_site_radius: Optional[bool] = None

    note: Optional[str] = None
    photo_url: Optional[str] = None
    client_submission_id: Optional[str] = Field(default=None, index=True)
    entry_source: str = Field(default="worker")
    created_by_supervisor_id: Optional[int] = Field(default=None, index=True)
    deleted_at: Optional[datetime] = Field(default=None, index=True)
    deleted_by_supervisor_id: Optional[int] = Field(default=None, index=True)
    deletion_reason: Optional[str] = None

    # "pending", "approved", "rejected"
    status: str = Field(default="pending")

    created_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc)
    )


class TaskLog(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)

    department_id: Optional[int] = Field(default=None, index=True)
    worker_id: int = Field(index=True)
    site_id: Optional[int] = Field(default=None, index=True)

    description: str
    work_date: Optional[str] = None
    hours_worked: Optional[float] = None
    safety_notes: Optional[str] = None
    photo_url: Optional[str] = None
    photo_urls: Optional[str] = None
    client_submission_id: Optional[str] = Field(default=None, index=True)
    entry_source: str = Field(default="worker")
    created_by_supervisor_id: Optional[int] = Field(default=None, index=True)
    status: str = Field(default="pending", index=True)
    deleted_at: Optional[datetime] = Field(default=None, index=True)
    deleted_by_supervisor_id: Optional[int] = Field(default=None, index=True)
    deletion_reason: Optional[str] = None

    created_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc)
    )


class TaskTemplate(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)

    department_id: Optional[int] = Field(default=None, index=True)
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

    department_id: Optional[int] = Field(default=None, index=True)
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

    department_id: Optional[int] = Field(default=None, index=True)
    form_id: int = Field(index=True)
    worker_id: int = Field(index=True)
    site_id: Optional[int] = Field(default=None, index=True)

    work_date: Optional[str] = None
    answers_json: str
    photo_urls: Optional[str] = None
    photo_metadata: Optional[str] = Field(default=None, sa_column=Column(Text, nullable=True))
    client_submission_id: Optional[str] = Field(default=None, index=True)
    status: str = Field(default="pending", index=True)
    deleted_at: Optional[datetime] = Field(default=None, index=True)
    deleted_by_supervisor_id: Optional[int] = Field(default=None, index=True)
    deletion_reason: Optional[str] = None

    created_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc)
    )


class TeamWorkLog(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)

    department_id: Optional[int] = Field(default=None, index=True)
    leader_id: int = Field(index=True)
    week_start: str = Field(index=True)
    notes: Optional[str] = None
    client_submission_id: Optional[str] = Field(default=None, index=True)
    status: str = Field(default="pending", index=True)
    deleted_at: Optional[datetime] = Field(default=None, index=True)
    deleted_by_supervisor_id: Optional[int] = Field(default=None, index=True)
    deletion_reason: Optional[str] = None

    created_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        index=True,
    )


class TeamWorkLogEntry(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)

    team_work_log_id: int = Field(index=True)
    worker_id: int = Field(index=True)
    site_id: int = Field(index=True)
    work_date: str = Field(index=True)
    start_time: str
    end_time: str
    break_minutes: int = Field(default=0)
    hours_worked: float
    work_description: str


class AuditEvent(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)

    department_id: Optional[int] = Field(default=None, index=True)
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
