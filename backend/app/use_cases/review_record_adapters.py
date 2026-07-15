from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from typing import Any

from sqlalchemy import String, cast, func, literal, or_
from sqlmodel import Session, select

from app.config import BUSINESS_TIMEZONE
from app.models import (
    AttendanceRecord,
    Site,
    TaskLog,
    TeamWorkLog,
    User,
    WorkForm,
    WorkFormSubmission,
)
from app.use_cases.common import review_record_response


def _like_pattern(value: str):
    escaped = value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


def _business_day_utc_bounds(value: str):
    business_date = date.fromisoformat(value)
    start = datetime.combine(business_date, time.min, BUSINESS_TIMEZONE)
    end = datetime.combine(business_date + timedelta(days=1), time.min, BUSINESS_TIMEZONE)
    return start.astimezone(timezone.utc), end.astimezone(timezone.utc)


@dataclass(frozen=True)
class ReviewRecordAdapter:
    kind: str
    model: Any
    actor_id_field: str
    record_date_field: str | None
    searchable_fields: tuple[str, ...]
    site_id_field: str | None = None
    form_id_field: str | None = None

    def key_select(
        self,
        *,
        department_id: int | None,
        status: str | None,
        record_date: str | None,
        search: str,
        snapshot_at,
    ):
        model = self.model
        status_expression = func.coalesce(model.status, "pending")
        statement = select(
            literal(self.kind).label("record_kind"),
            model.id.label("record_id"),
            model.created_at.label("created_at"),
            status_expression.label("status"),
        ).where(
            model.deleted_at.is_(None),
            model.created_at <= snapshot_at,
        )

        if department_id is not None:
            statement = statement.where(model.department_id == department_id)
        if status:
            statement = statement.where(status_expression == status)
        if record_date:
            if self.record_date_field:
                statement = statement.where(getattr(model, self.record_date_field) == record_date)
            else:
                start, end = _business_day_utc_bounds(record_date)
                statement = statement.where(
                    model.created_at >= start,
                    model.created_at < end,
                )
        if search:
            statement = statement.where(self.search_predicate(search))
        return statement

    def search_predicate(self, search: str):
        pattern = _like_pattern(search)
        model = self.model
        predicates = [
            cast(model.id, String).ilike(pattern, escape="\\"),
            *[
                cast(getattr(model, field), String).ilike(pattern, escape="\\")
                for field in self.searchable_fields
            ],
        ]
        actor_id = getattr(model, self.actor_id_field)
        predicates.append(
            select(User.id).where(
                User.id == actor_id,
                or_(
                    User.name.ilike(pattern, escape="\\"),
                    User.email.ilike(pattern, escape="\\"),
                ),
            ).exists()
        )

        if self.site_id_field:
            site_id = getattr(model, self.site_id_field)
            predicates.append(
                select(Site.id).where(
                    Site.id == site_id,
                    Site.name.ilike(pattern, escape="\\"),
                ).exists()
            )
        if self.form_id_field:
            form_id = getattr(model, self.form_id_field)
            predicates.append(
                select(WorkForm.id).where(
                    WorkForm.id == form_id,
                    WorkForm.name.ilike(pattern, escape="\\"),
                ).exists()
            )
        return or_(*predicates)

    def load_many(self, session: Session, record_ids: list[int]):
        if not record_ids:
            return {}
        records = session.exec(
            select(self.model).where(self.model.id.in_(record_ids))
        ).all()
        return {record.id: record for record in records}

    def serialize(self, record, session: Session):
        item = review_record_response(self.kind, record, session)
        item["durability"] = "durable"
        item["read_only"] = False
        return item


REVIEW_RECORD_ADAPTERS = {
    "attendance": ReviewRecordAdapter(
        kind="attendance",
        model=AttendanceRecord,
        actor_id_field="worker_id",
        record_date_field=None,
        searchable_fields=("record_type", "note"),
        site_id_field="site_id",
    ),
    "task": ReviewRecordAdapter(
        kind="task",
        model=TaskLog,
        actor_id_field="worker_id",
        record_date_field="work_date",
        searchable_fields=("description", "safety_notes"),
        site_id_field="site_id",
    ),
    "form": ReviewRecordAdapter(
        kind="form",
        model=WorkFormSubmission,
        actor_id_field="worker_id",
        record_date_field="work_date",
        searchable_fields=("answers_json",),
        site_id_field="site_id",
        form_id_field="form_id",
    ),
    "team_log": ReviewRecordAdapter(
        kind="team_log",
        model=TeamWorkLog,
        actor_id_field="leader_id",
        record_date_field="week_start",
        searchable_fields=("notes",),
    ),
}
