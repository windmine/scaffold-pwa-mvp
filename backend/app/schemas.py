from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field

from app.use_cases.common import MAX_WORK_FORM_FIELDS


class LoginRequest(BaseModel):
    email: str = Field(min_length=3, max_length=320)
    password: str = Field(min_length=1, max_length=72)


class RegistrationStartRequest(BaseModel):
    email: str = Field(min_length=3, max_length=320)
    name: str = Field(min_length=1, max_length=120)


class RegistrationVerifyRequest(BaseModel):
    verification_id: int = Field(ge=1)
    code: str = Field(pattern=r"^\d{6}$")


class RegisterRequest(BaseModel):
    verification_token: str = Field(min_length=20, max_length=200)
    password: str = Field(min_length=8, max_length=72)
    department_id: int = Field(ge=1)


class UserCreateRequest(BaseModel):
    email: str = Field(min_length=3, max_length=320)
    name: str = Field(min_length=1, max_length=120)
    password: str = Field(min_length=8, max_length=72)
    role: str = Field(default="worker", max_length=40)
    worker_class: str = Field(default="normal", max_length=40)
    department_id: Optional[int] = Field(default=None, ge=1)
    is_global_admin: bool = False


class UserUpdateRequest(BaseModel):
    email: Optional[str] = Field(default=None, min_length=3, max_length=320)
    name: Optional[str] = Field(default=None, min_length=1, max_length=120)
    password: Optional[str] = Field(default=None, min_length=8, max_length=72)
    role: Optional[str] = Field(default=None, max_length=40)
    worker_class: Optional[str] = Field(default=None, max_length=40)
    status: Optional[str] = Field(default=None, max_length=40)
    department_id: Optional[int] = Field(default=None, ge=1)
    is_global_admin: Optional[bool] = None
    confirmed: bool = False


class UserStatusRequest(BaseModel):
    status: str = Field(max_length=40)
    confirmed: bool = False


class DefaultDepartmentRequest(BaseModel):
    department_id: Optional[int] = Field(default=None, ge=1)


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
    worker_id: Optional[int] = Field(default=None, ge=1)
    record_type: str
    occurred_at: Optional[datetime] = None
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    accuracy: Optional[float] = Field(default=None, ge=0)
    site_id: Optional[int] = Field(default=None, ge=1)
    note: Optional[str] = Field(default=None, max_length=1000)
    photo_url: Optional[str] = Field(default=None, max_length=500)
    client_submission_id: Optional[str] = Field(default=None, max_length=120)


class SupervisorAttendanceCreate(BaseModel):
    worker_id: int = Field(ge=1)
    site_id: int = Field(ge=1)
    record_type: str = Field(max_length=40)
    occurred_at: datetime
    note: str = Field(min_length=3, max_length=1000)
    confirmed: bool = False


class RecordTrashRequest(BaseModel):
    reason: str = Field(min_length=3, max_length=1000)
    confirmed: bool = False


class RecordRestoreRequest(BaseModel):
    confirmed: bool = False


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
    client_submission_id: Optional[str] = Field(default=None, max_length=120)


class SupervisorTaskLogCreate(BaseModel):
    user_id: int = Field(ge=1)
    site_id: int = Field(ge=1)
    work_date: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    hours_worked: Optional[float] = Field(default=None, ge=0, le=24)
    description: str = Field(min_length=1, max_length=3000)
    safety_notes: Optional[str] = Field(default=None, max_length=1500)
    confirmed: bool = False


class TaskLogUpdateRequest(BaseModel):
    description: Optional[str] = Field(default=None, min_length=1, max_length=3000)
    site_id: Optional[int] = Field(default=None, ge=1)
    work_date: Optional[str] = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    hours_worked: Optional[float] = Field(default=None, ge=0, le=24)
    safety_notes: Optional[str] = Field(default=None, max_length=1500)
    photo_url: Optional[str] = Field(default=None, max_length=500)
    photo_urls: Optional[list[str]] = None
    status: Optional[str] = Field(default=None, max_length=40)
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


class WorkFormField(BaseModel):
    id: str = Field(min_length=1, max_length=80)
    label: str = Field(min_length=1, max_length=160)
    type: str = Field(max_length=40)
    required: bool = False
    options: list[str] = Field(default_factory=list)
    show_if: Optional[str] = Field(default=None, max_length=240)
    formula: Optional[str] = Field(default=None, max_length=500)
    repeat: Optional[str] = Field(default=None, max_length=80)
    min_rows: Optional[int] = Field(default=None, ge=0, le=50)
    max_rows: Optional[int] = Field(default=None, ge=1, le=50)


class WorkFormCreate(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    description: Optional[str] = Field(default=None, max_length=500)
    fields: list[WorkFormField] = Field(min_length=1, max_length=MAX_WORK_FORM_FIELDS)


class WorkFormUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=160)
    description: Optional[str] = Field(default=None, max_length=500)
    fields: Optional[list[WorkFormField]] = Field(default=None, min_length=1, max_length=MAX_WORK_FORM_FIELDS)
    status: Optional[str] = Field(default=None, max_length=40)
    confirmed: bool = False


class WorkFormSubmissionCreate(BaseModel):
    form_id: int = Field(ge=1)
    site_id: Optional[int] = Field(default=None, ge=1)
    work_date: Optional[str] = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    answers: dict = Field(default_factory=dict)
    photo_urls: list[str] = Field(default_factory=list)
    photo_metadata: list[dict] = Field(default_factory=list)
    client_submission_id: Optional[str] = Field(default=None, max_length=120)


class SupervisorWorkFormSubmissionCreate(BaseModel):
    user_id: int = Field(ge=1)
    form_id: int = Field(ge=1)
    site_id: Optional[int] = Field(default=None, ge=1)
    work_date: Optional[str] = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    answers: dict = Field(default_factory=dict)
    confirmed: bool = False


class SupervisorWorkFormSubmissionUpdate(BaseModel):
    site_id: Optional[int] = Field(default=None, ge=1)
    work_date: Optional[str] = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    answers: Optional[dict] = None
    photo_urls: Optional[list[str]] = None
    status: Optional[str] = Field(default=None, max_length=40)
    confirmed: bool = False


class TeamWorkLogEntryCreate(BaseModel):
    worker_id: int = Field(ge=1)
    site_id: int = Field(ge=1)
    work_date: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    start_time: str = Field(pattern=r"^\d{2}:\d{2}$")
    end_time: str = Field(pattern=r"^\d{2}:\d{2}$")
    break_minutes: int = Field(default=0, ge=0, le=60)
    work_description: str = Field(min_length=1, max_length=3000)


class TeamWorkLogCreate(BaseModel):
    week_start: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    notes: Optional[str] = Field(default=None, max_length=3000)
    entries: list[TeamWorkLogEntryCreate] = Field(min_length=1, max_length=150)
    client_submission_id: Optional[str] = Field(default=None, max_length=120)


class TeamWorkLogUpdateRequest(BaseModel):
    week_start: Optional[str] = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    notes: Optional[str] = Field(default=None, max_length=3000)
    entries: Optional[list[TeamWorkLogEntryCreate]] = Field(default=None, min_length=1, max_length=150)
    status: Optional[str] = Field(default=None, max_length=40)
    confirmed: bool = False


class ApprovalRequest(BaseModel):
    status: str = Field(max_length=40)
    comment: Optional[str] = Field(default=None, max_length=1000)
    record_type: str = Field(default="attendance", max_length=40)
