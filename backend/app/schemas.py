from typing import Optional

from pydantic import BaseModel, Field

from app.use_cases.common import MAX_WORK_FORM_FIELDS


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


class UserUpdateRequest(BaseModel):
    email: Optional[str] = Field(default=None, min_length=3, max_length=320)
    name: Optional[str] = Field(default=None, min_length=1, max_length=120)
    password: Optional[str] = Field(default=None, min_length=8, max_length=72)
    role: Optional[str] = Field(default=None, max_length=40)
    status: Optional[str] = Field(default=None, max_length=40)
    confirmed: bool = False


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
    client_submission_id: Optional[str] = Field(default=None, max_length=120)


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
    client_submission_id: Optional[str] = Field(default=None, max_length=120)


class ApprovalRequest(BaseModel):
    status: str = Field(max_length=40)
    comment: Optional[str] = Field(default=None, max_length=1000)
    record_type: str = Field(default="attendance", max_length=40)
