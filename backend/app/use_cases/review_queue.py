import base64
import binascii
import hashlib
import json
from dataclasses import asdict, dataclass
from datetime import date, datetime, timezone
from typing import Optional

from fastapi import HTTPException
from sqlalchemy import and_, func, or_, union_all
from sqlmodel import Session, select

from app.models import User
from app.use_cases.common import (
    normalize_approval_record_type,
    user_is_global_admin,
    validate_review_status,
)
from app.use_cases.review_record_adapters import REVIEW_RECORD_ADAPTERS


DEFAULT_REVIEW_PAGE_SIZE = 50
MAX_REVIEW_PAGE_SIZE = 100
CURSOR_VERSION = 1


@dataclass(frozen=True)
class ReviewRecordQuery:
    status: str | None
    kind: str | None
    department_id: int | None
    record_date: str | None
    search: str

    def fingerprint(self):
        canonical = json.dumps(asdict(self), separators=(",", ":"), sort_keys=True)
        return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:24]


def _as_utc(value: datetime):
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def normalize_review_record_query(
    supervisor: User,
    *,
    status: Optional[str] = None,
    kind: Optional[str] = None,
    department_id: Optional[int] = None,
    record_date: Optional[str] = None,
    search: Optional[str] = None,
):
    normalized_status = validate_review_status(status) if status else None
    normalized_kind = normalize_approval_record_type(kind) if kind else None

    if not user_is_global_admin(supervisor):
        if department_id is not None and department_id != supervisor.department_id:
            raise HTTPException(status_code=404, detail="Department not found")
        department_id = supervisor.department_id

    normalized_date = None
    if record_date:
        try:
            normalized_date = date.fromisoformat(record_date).isoformat()
        except ValueError:
            raise HTTPException(status_code=400, detail="record_date must use YYYY-MM-DD")

    normalized_search = " ".join(str(search or "").split())
    if len(normalized_search) > 160:
        raise HTTPException(status_code=400, detail="search must be 160 characters or fewer")

    return ReviewRecordQuery(
        status=normalized_status,
        kind=normalized_kind,
        department_id=department_id,
        record_date=normalized_date,
        search=normalized_search,
    )


def _encode_cursor(snapshot_at: datetime, created_at: datetime, record_kind: str, record_id: int, filter_hash: str):
    snapshot_at = _as_utc(snapshot_at)
    created_at = _as_utc(created_at)
    payload = json.dumps(
        {
            "v": CURSOR_VERSION,
            "snapshot_at": snapshot_at.isoformat(),
            "created_at": created_at.isoformat(),
            "kind": record_kind,
            "id": int(record_id),
            "filter_hash": filter_hash,
        },
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return base64.urlsafe_b64encode(payload).decode("ascii").rstrip("=")


def _decode_cursor(cursor: str, expected_filter_hash: str):
    try:
        padding = "=" * (-len(cursor) % 4)
        decoded = base64.b64decode(cursor + padding, altchars=b"-_", validate=True)
        payload = json.loads(decoded.decode("utf-8"))
        if payload.get("v") != CURSOR_VERSION:
            raise ValueError
        if payload.get("filter_hash") != expected_filter_hash:
            raise HTTPException(
                status_code=400,
                detail="Review Queue cursor does not match the active filters",
            )
        snapshot_at = _as_utc(datetime.fromisoformat(payload["snapshot_at"]))
        created_at = _as_utc(datetime.fromisoformat(payload["created_at"]))
        record_kind = str(payload["kind"])
        record_id = int(payload["id"])
    except HTTPException:
        raise
    except (
        ValueError,
        TypeError,
        KeyError,
        json.JSONDecodeError,
        UnicodeDecodeError,
        binascii.Error,
    ):
        raise HTTPException(status_code=400, detail="Review Queue cursor is invalid")

    if (
        record_kind not in REVIEW_RECORD_ADAPTERS
        or record_id < 1
    ):
        raise HTTPException(status_code=400, detail="Review Queue cursor is invalid")
    return snapshot_at, created_at, record_kind, record_id


def _combined_query(query: ReviewRecordQuery, snapshot_at: datetime):
    adapters = (
        [REVIEW_RECORD_ADAPTERS[query.kind]]
        if query.kind
        else list(REVIEW_RECORD_ADAPTERS.values())
    )
    return union_all(
        *[
            adapter.key_select(
                department_id=query.department_id,
                status=query.status,
                record_date=query.record_date,
                search=query.search,
                snapshot_at=snapshot_at,
            )
            for adapter in adapters
        ]
    ).subquery("review_queue")


def _review_record_counts(session: Session, combined):
    rows = session.exec(
        select(
            combined.c.record_kind,
            combined.c.status,
            func.count().label("record_count"),
        ).group_by(combined.c.record_kind, combined.c.status)
    ).all()
    counts = {
        "total": 0,
        "pending": 0,
        "reviewed": 0,
        "attendance": 0,
        "task": 0,
        "form": 0,
        "team_log": 0,
    }
    for record_kind, status, count in rows:
        count = int(count)
        counts["total"] += count
        counts[record_kind] += count
        if status == "pending":
            counts["pending"] += count
        else:
            counts["reviewed"] += count
    return counts


def list_review_record_page(
    session: Session,
    supervisor: User,
    status: Optional[str] = None,
    kind: Optional[str] = None,
    department_id: Optional[int] = None,
    record_date: Optional[str] = None,
    search: Optional[str] = None,
    cursor: Optional[str] = None,
    page_size: int = DEFAULT_REVIEW_PAGE_SIZE,
):
    if page_size < 1 or page_size > MAX_REVIEW_PAGE_SIZE:
        raise HTTPException(
            status_code=400,
            detail=f"page_size must be between 1 and {MAX_REVIEW_PAGE_SIZE}",
        )
    query = normalize_review_record_query(
        supervisor,
        status=status,
        kind=kind,
        department_id=department_id,
        record_date=record_date,
        search=search,
    )
    filter_hash = query.fingerprint()
    snapshot_at = datetime.now(timezone.utc)
    cursor_key = None
    if cursor:
        snapshot_at, cursor_created_at, cursor_kind, cursor_id = _decode_cursor(cursor, filter_hash)
        cursor_key = (cursor_created_at, cursor_kind, cursor_id)

    combined = _combined_query(query, snapshot_at)
    summary_query = ReviewRecordQuery(
        status=None,
        kind=None,
        department_id=query.department_id,
        record_date=None,
        search="",
    )
    summary_combined = (
        combined
        if summary_query == query
        else _combined_query(summary_query, snapshot_at)
    )
    statement = select(
        combined.c.record_kind,
        combined.c.record_id,
        combined.c.created_at,
    )
    if cursor_key:
        cursor_created_at, cursor_kind, cursor_id = cursor_key
        statement = statement.where(
            or_(
                combined.c.created_at < cursor_created_at,
                and_(
                    combined.c.created_at == cursor_created_at,
                    or_(
                        combined.c.record_kind > cursor_kind,
                        and_(
                            combined.c.record_kind == cursor_kind,
                            combined.c.record_id < cursor_id,
                        ),
                    ),
                ),
            )
        )
    statement = statement.order_by(
        combined.c.created_at.desc(),
        combined.c.record_kind.asc(),
        combined.c.record_id.desc(),
    ).limit(page_size + 1)
    rows = list(session.exec(statement).all())
    has_more = len(rows) > page_size
    page_rows = rows[:page_size]

    ids_by_kind = {}
    for record_kind, record_id, _ in page_rows:
        ids_by_kind.setdefault(record_kind, []).append(record_id)
    records_by_kind = {
        record_kind: REVIEW_RECORD_ADAPTERS[record_kind].load_many(session, record_ids)
        for record_kind, record_ids in ids_by_kind.items()
    }
    items = []
    for record_kind, record_id, _ in page_rows:
        record = records_by_kind.get(record_kind, {}).get(record_id)
        if record:
            items.append(REVIEW_RECORD_ADAPTERS[record_kind].serialize(record, session))

    next_cursor = None
    if has_more and page_rows:
        last_kind, last_id, last_created_at = page_rows[-1]
        next_cursor = _encode_cursor(
            snapshot_at,
            last_created_at,
            last_kind,
            last_id,
            filter_hash,
        )

    matching_counts = _review_record_counts(session, combined)
    summary_counts = (
        matching_counts
        if summary_combined is combined
        else _review_record_counts(session, summary_combined)
    )
    return {
        "items": items,
        "next_cursor": next_cursor,
        "has_more": has_more,
        "page_size": page_size,
        "counts": matching_counts,
        "summary_counts": summary_counts,
        "snapshot_at": snapshot_at.isoformat().replace("+00:00", "Z"),
        "durability": "durable",
        "read_only": False,
    }


def list_review_records(session: Session, supervisor: User, status: Optional[str] = None):
    query = normalize_review_record_query(supervisor, status=status)
    snapshot_at = datetime.now(timezone.utc)
    combined = _combined_query(query, snapshot_at)
    rows = session.exec(
        select(combined.c.record_kind, combined.c.record_id, combined.c.created_at)
        .order_by(
            combined.c.created_at.desc(),
            combined.c.record_kind.asc(),
            combined.c.record_id.desc(),
        )
    ).all()
    ids_by_kind = {}
    for record_kind, record_id, _ in rows:
        ids_by_kind.setdefault(record_kind, []).append(record_id)
    loaded = {
        record_kind: REVIEW_RECORD_ADAPTERS[record_kind].load_many(session, ids)
        for record_kind, ids in ids_by_kind.items()
    }
    return [
        REVIEW_RECORD_ADAPTERS[record_kind].serialize(loaded[record_kind][record_id], session)
        for record_kind, record_id, _ in rows
        if record_id in loaded.get(record_kind, {})
    ]
