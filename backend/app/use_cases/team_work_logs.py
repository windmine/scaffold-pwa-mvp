from datetime import date, timedelta

from fastapi import HTTPException
from sqlmodel import Session, select

from app.models import Site, TeamWorkLog, TeamWorkLogEntry, User
from app.use_cases.audit import add_audit_event, model_snapshot
from app.use_cases.common import (
    can_access_department,
    department_id_for_new_record,
    normalize_client_submission_id,
    require_leader,
    select_team_work_logs,
    team_work_log_response,
)


def _parse_date(value: str, label: str):
    try:
        return date.fromisoformat(value)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"{label} is invalid")


def _time_minutes(value: str, label: str):
    try:
        hours, minutes = (int(part) for part in value.split(":", 1))
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail=f"{label} is invalid")
    if not 0 <= hours <= 23 or not 0 <= minutes <= 59:
        raise HTTPException(status_code=400, detail=f"{label} is invalid")
    return (hours * 60) + minutes


def _entry_hours(start_time: str, end_time: str, break_minutes: int):
    start = _time_minutes(start_time, "Start time")
    end = _time_minutes(end_time, "End time")
    if end <= start:
        end += 24 * 60
    worked_minutes = end - start - break_minutes
    if worked_minutes <= 0:
        raise HTTPException(status_code=400, detail="Break must be shorter than the work period")
    return round(worked_minutes / 60, 2)


def list_team_members(user: User, session: Session):
    require_leader(user)
    members = session.exec(
        select(User)
        .where(
            User.department_id == user.department_id,
            User.role == "worker",
            User.status == "active",
        )
        .order_by(User.name)
    ).all()
    return [
        {
            "id": member.id,
            "name": member.name,
            "worker_class": member.worker_class or "normal",
            "department_id": member.department_id,
        }
        for member in members
    ]


def create_team_work_log(data, leader: User, session: Session):
    require_leader(leader)
    department_id = department_id_for_new_record(leader, session)
    week_start = _parse_date(data.week_start, "Week start")
    if week_start.weekday() != 0:
        raise HTTPException(status_code=400, detail="Week start must be a Monday")
    week_end = week_start + timedelta(days=6)
    client_submission_id = normalize_client_submission_id(data.client_submission_id)

    if client_submission_id:
        existing = session.exec(
            select(TeamWorkLog).where(
                TeamWorkLog.leader_id == leader.id,
                TeamWorkLog.client_submission_id == client_submission_id,
            )
        ).first()
        if existing:
            return team_work_log_response(existing, session)

    prepared_entries = []
    for index, raw in enumerate(data.entries, start=1):
        worker = session.get(User, raw.worker_id)
        if (
            not worker
            or worker.role != "worker"
            or worker.status != "active"
            or worker.department_id != department_id
        ):
            raise HTTPException(status_code=400, detail=f"Row {index}: member is not an active worker in this department")

        site = session.get(Site, raw.site_id)
        if not site or site.department_id != department_id:
            raise HTTPException(status_code=400, detail=f"Row {index}: site is not in this department")

        work_date = _parse_date(raw.work_date, f"Row {index} work date")
        if work_date < week_start or work_date > week_end:
            raise HTTPException(status_code=400, detail=f"Row {index}: work date must be within the selected week")

        description = raw.work_description.strip()
        if not description:
            raise HTTPException(status_code=400, detail=f"Row {index}: work completed is required")

        prepared_entries.append({
            "worker_id": worker.id,
            "site_id": site.id,
            "work_date": raw.work_date,
            "start_time": raw.start_time,
            "end_time": raw.end_time,
            "break_minutes": raw.break_minutes,
            "hours_worked": _entry_hours(raw.start_time, raw.end_time, raw.break_minutes),
            "work_description": description,
        })

    log = TeamWorkLog(
        department_id=department_id,
        leader_id=leader.id,
        week_start=data.week_start,
        notes=data.notes.strip() if data.notes else None,
        client_submission_id=client_submission_id,
        status="pending",
    )
    session.add(log)
    session.flush()

    for entry in prepared_entries:
        session.add(TeamWorkLogEntry(team_work_log_id=log.id, **entry))

    add_audit_event(
        session=session,
        actor=leader,
        action="team_work_log_create",
        entity_type="team_log",
        entity_id=log.id,
        after=model_snapshot(log),
        summary=f"Submitted weekly team log for {data.week_start}",
        department_id=department_id,
    )
    session.commit()
    session.refresh(log)
    return team_work_log_response(log, session)


def list_my_team_work_logs(leader: User, session: Session):
    require_leader(leader)
    logs = session.exec(
        select(TeamWorkLog)
        .where(TeamWorkLog.leader_id == leader.id)
        .order_by(TeamWorkLog.created_at.desc())
    ).all()
    return [team_work_log_response(log, session) for log in logs]


def list_supervisor_team_work_logs(status: str | None, supervisor: User, session: Session):
    logs = session.exec(select_team_work_logs(status, supervisor)).all()
    return [team_work_log_response(log, session) for log in logs]


def get_team_work_log(log_id: int, user: User, session: Session):
    log = session.get(TeamWorkLog, log_id)
    if not log or not can_access_department(user, log.department_id):
        raise HTTPException(status_code=404, detail="Team work log not found")
    if user.role == "worker" and log.leader_id != user.id:
        raise HTTPException(status_code=404, detail="Team work log not found")
    return team_work_log_response(log, session)
