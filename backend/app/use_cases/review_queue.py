import base64
import binascii
import hashlib
import json
from dataclasses import asdict, dataclass
from datetime import date, datetime, timezone
from typing import Optional

from fastapi import HTTPException
from sqlalchemy import and_, case, false, func, or_, union_all
from sqlmodel import Session, select

from app.models import User, WorkFormSubmission
from app.use_cases.common import (
    VALID_REPORT_WORKFLOW_STATUSES,
    normalize_approval_record_type,
    normalize_work_form_purpose,
    user_is_global_admin,
    validate_review_status,
)
from app.use_cases.review_record_adapters import REVIEW_RECORD_ADAPTERS


DEFAULT_REVIEW_PAGE_SIZE = 50
MAX_REVIEW_PAGE_SIZE = 100
CURSOR_VERSION = 1
REVIEW_SORT_ORDERS = {"newest", "oldest_waiting"}
REPORT_WORKFLOW_RANKS = {"submitted": 0, "in_review": 1, "resolved": 2}


@dataclass(frozen=True)
class ReviewRecordQuery:
    status: str | None
    workflow_status: str | None
    purpose: str | None
    kind: str | None
    department_id: int | None
    form_id: int | None
    worker_id: int | None
    record_date: str | None
    search: str

    def fingerprint(self, sort_order="newest"):
        filters = asdict(self)
        # Keep already-issued newest cursors compatible with the default query.
        if sort_order != "newest":
            filters["sort_order"] = sort_order
        canonical = json.dumps(filters, separators=(",", ":"), sort_keys=True)
        return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:24]


def _as_utc(value: datetime):
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def normalize_review_search(search: Optional[str] = None):
    normalized = " ".join(str(search or "").split())
    if len(normalized) > 160:
        raise HTTPException(status_code=400, detail="search must be 160 characters or fewer")
    return normalized


def normalize_review_record_query(
    supervisor: User,
    *,
    status: Optional[str] = None,
    workflow_status: Optional[str] = None,
    purpose: Optional[str] = None,
    kind: Optional[str] = None,
    department_id: Optional[int] = None,
    form_id: Optional[int] = None,
    worker_id: Optional[int] = None,
    record_date: Optional[str] = None,
    search: Optional[str] = None,
):
    normalized_status = validate_review_status(status) if status else None
    normalized_workflow_status = str(workflow_status or '').strip().lower() or None
    if normalized_workflow_status and normalized_workflow_status not in VALID_REPORT_WORKFLOW_STATUSES:
        raise HTTPException(
            status_code=400,
            detail="workflow_status must be submitted, in_review, or resolved",
        )
    normalized_purpose = normalize_work_form_purpose(purpose)
    normalized_kind = normalize_approval_record_type(kind) if kind else None

    if form_id is not None and form_id < 1:
        raise HTTPException(status_code=400, detail="form_id must be a positive integer")
    if worker_id is not None and worker_id < 1:
        raise HTTPException(status_code=400, detail="worker_id must be a positive integer")

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

    normalized_search = normalize_review_search(search)

    return ReviewRecordQuery(
        status=normalized_status,
        workflow_status=normalized_workflow_status,
        purpose=normalized_purpose,
        kind=normalized_kind,
        department_id=department_id,
        form_id=form_id,
        worker_id=worker_id,
        record_date=normalized_date,
        search=normalized_search,
    )


def _encode_cursor(
    snapshot_at: datetime, created_at: datetime, record_kind: str, record_id: int,
    filter_hash: str, *, sort_order="newest", workflow_rank=None, order_snapshot_hash=None,
):
    snapshot_at = _as_utc(snapshot_at)
    created_at = _as_utc(created_at)
    values = {
        "v": CURSOR_VERSION,
        "snapshot_at": snapshot_at.isoformat(),
        "created_at": created_at.isoformat(),
        "kind": record_kind,
        "id": int(record_id),
        "filter_hash": filter_hash,
    }
    if sort_order != "newest":
        values.update(
            sort_order=sort_order,
            workflow_rank=workflow_rank,
            order_snapshot_hash=order_snapshot_hash,
        )
    payload = json.dumps(
        values,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return base64.urlsafe_b64encode(payload).decode("ascii").rstrip("=")


def _decode_cursor(cursor: str, expected_filter_hash: str, sort_order="newest"):
    try:
        padding = "=" * (-len(cursor) % 4)
        decoded = base64.b64decode(cursor + padding, altchars=b"-_", validate=True)
        payload = json.loads(decoded.decode("utf-8"))
        if not isinstance(payload, dict) or payload.get("v") != CURSOR_VERSION:
            raise ValueError
        if (
            payload.get("filter_hash") != expected_filter_hash
            or payload.get("sort_order", "newest") != sort_order
        ):
            raise HTTPException(
                status_code=400,
                detail="Review Queue cursor does not match the active filters",
            )
        snapshot_at = _as_utc(datetime.fromisoformat(payload["snapshot_at"]))
        created_at = _as_utc(datetime.fromisoformat(payload["created_at"]))
        record_kind = str(payload["kind"])
        record_id = int(payload["id"])
        workflow_rank = payload.get("workflow_rank")
        order_snapshot_hash = payload.get("order_snapshot_hash")
        if sort_order == "oldest_waiting" and (
            record_kind != "form"
            or type(workflow_rank) is not int
            or workflow_rank not in REPORT_WORKFLOW_RANKS.values()
            or not isinstance(order_snapshot_hash, str)
            or len(order_snapshot_hash) != 64
            or any(character not in "0123456789abcdef" for character in order_snapshot_hash)
        ):
            raise ValueError
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
    return snapshot_at, created_at, record_kind, record_id, workflow_rank, order_snapshot_hash


def _combined_query(query: ReviewRecordQuery, snapshot_at: datetime, sort_order="newest"):
    if sort_order == "oldest_waiting":
        # Reports only move forward. Reconstruct their rank at the first page's
        # snapshot so ordinary later transitions preserve pagination position.
        # These are operation timestamps, not commit timestamps. The exact key
        # digest below invalidates a traversal if a previously invisible commit
        # changes these reconstructed ranks or the matching membership.
        # Serialization still exposes the current authoritative workflow.
        workflow_rank = case(
            (WorkFormSubmission.review_started_at > snapshot_at, 0),
            (WorkFormSubmission.resolved_at > snapshot_at, 1),
            (func.coalesce(WorkFormSubmission.workflow_status, "submitted") == "submitted", 0),
            (WorkFormSubmission.workflow_status == "in_review", 1),
            else_=2,
        )
        statement = REVIEW_RECORD_ADAPTERS["form"].key_select(
            department_id=query.department_id,
            status=query.status,
            workflow_status=None,
            purpose=query.purpose,
            form_id=query.form_id,
            worker_id=query.worker_id,
            record_date=query.record_date,
            search=query.search,
            snapshot_at=snapshot_at,
        ).add_columns(workflow_rank.label("workflow_rank"))
        if query.kind and query.kind != "form":
            statement = statement.where(false())
        if query.workflow_status:
            statement = statement.where(workflow_rank == REPORT_WORKFLOW_RANKS[query.workflow_status])
        return statement.subquery("review_queue")
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
                workflow_status=query.workflow_status,
                purpose=query.purpose,
                form_id=query.form_id,
                worker_id=query.worker_id,
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


def _review_order_snapshot_hash(session: Session, combined):
    # Exact membership/rank binding, not a max timestamp or count approximation.
    # Two O(matching Reports) key scans per page bracket page/load/count reads.
    # yield_per streams bounded batches (including a server-side PostgreSQL
    # cursor); only the fixed-size SHA-256 digest is retained or sent to clients.
    statement = select(
        combined.c.record_id,
        combined.c.created_at,
        combined.c.workflow_rank,
    ).order_by(combined.c.record_id.asc()).execution_options(yield_per=256)
    digest = hashlib.sha256()
    rows = session.exec(statement)
    try:
        for record_id, created_at, workflow_rank in rows:
            key = [
                int(record_id),
                _as_utc(created_at).isoformat(timespec="microseconds"),
                int(workflow_rank),
            ]
            digest.update(json.dumps(key, separators=(",", ":")).encode("utf-8"))
            digest.update(b"\n")
    finally:
        rows.close()
    return digest.hexdigest()


def _report_review_order_changed():
    raise HTTPException(status_code=409, detail={
        "code": "report_review_order_changed",
        "message": "Reports changed while loading Oldest waiting. Refresh Reports to restart this list.",
    })


def list_review_record_page(
    session: Session,
    supervisor: User,
    status: Optional[str] = None,
    workflow_status: Optional[str] = None,
    purpose: Optional[str] = None,
    kind: Optional[str] = None,
    department_id: Optional[int] = None,
    form_id: Optional[int] = None,
    worker_id: Optional[int] = None,
    record_date: Optional[str] = None,
    search: Optional[str] = None,
    cursor: Optional[str] = None,
    page_size: int = DEFAULT_REVIEW_PAGE_SIZE,
    sort_order: Optional[str] = None,
):
    if page_size < 1 or page_size > MAX_REVIEW_PAGE_SIZE:
        raise HTTPException(
            status_code=400,
            detail=f"page_size must be between 1 and {MAX_REVIEW_PAGE_SIZE}",
        )
    query = normalize_review_record_query(
        supervisor,
        status=status,
        workflow_status=workflow_status,
        purpose=purpose,
        kind=kind,
        department_id=department_id,
        form_id=form_id,
        worker_id=worker_id,
        record_date=record_date,
        search=search,
    )
    sort_order = "newest" if sort_order is None else str(sort_order).strip().lower()
    if sort_order not in REVIEW_SORT_ORDERS:
        raise HTTPException(status_code=400, detail="sort_order must be newest or oldest_waiting")
    if sort_order == "oldest_waiting" and query.purpose != "report":
        raise HTTPException(status_code=400, detail="oldest_waiting requires purpose=report")
    filter_hash = query.fingerprint(sort_order)
    snapshot_at = datetime.now(timezone.utc)
    cursor_key = None
    expected_order_snapshot_hash = None
    if cursor:
        (snapshot_at, cursor_created_at, cursor_kind, cursor_id, cursor_rank,
         expected_order_snapshot_hash) = _decode_cursor(
            cursor, filter_hash, sort_order,
        )
        cursor_key = (cursor_created_at, cursor_kind, cursor_id, cursor_rank)

    combined = _combined_query(query, snapshot_at, sort_order)
    order_snapshot_hash = None
    if sort_order == "oldest_waiting":
        order_snapshot_hash = _review_order_snapshot_hash(session, combined)
        if expected_order_snapshot_hash is not None and expected_order_snapshot_hash != order_snapshot_hash:
            _report_review_order_changed()
    summary_query = ReviewRecordQuery(
        status=None,
        workflow_status=None,
        purpose=query.purpose,
        kind=None,
        department_id=query.department_id,
        form_id=None,
        worker_id=None,
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
    if sort_order == "oldest_waiting":
        statement = statement.add_columns(combined.c.workflow_rank)
        if cursor_key:
            cursor_created_at, _, cursor_id, cursor_rank = cursor_key
            statement = statement.where(or_(
                combined.c.workflow_rank > cursor_rank,
                and_(
                    combined.c.workflow_rank == cursor_rank,
                    or_(
                        combined.c.created_at > cursor_created_at,
                        and_(
                            combined.c.created_at == cursor_created_at,
                            combined.c.record_id > cursor_id,
                        ),
                    ),
                ),
            ))
        statement = statement.order_by(
            combined.c.workflow_rank.asc(),
            combined.c.created_at.asc(),
            combined.c.record_id.asc(),
        )
    elif cursor_key:
        cursor_created_at, cursor_kind, cursor_id, _ = cursor_key
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
    if sort_order == "newest":
        statement = statement.order_by(
            combined.c.created_at.desc(),
            combined.c.record_kind.asc(),
            combined.c.record_id.desc(),
        )
    statement = statement.limit(page_size + 1)
    rows = list(session.exec(statement).all())
    has_more = len(rows) > page_size
    page_rows = rows[:page_size]

    ids_by_kind = {}
    for record_kind, record_id, *_ in page_rows:
        ids_by_kind.setdefault(record_kind, []).append(record_id)
    records_by_kind = {
        record_kind: REVIEW_RECORD_ADAPTERS[record_kind].load_many(session, record_ids)
        for record_kind, record_ids in ids_by_kind.items()
    }
    items = []
    for record_kind, record_id, *_ in page_rows:
        record = records_by_kind.get(record_kind, {}).get(record_id)
        if record:
            items.append(REVIEW_RECORD_ADAPTERS[record_kind].serialize(record, session))

    next_cursor = None
    if has_more and page_rows:
        last_kind, last_id, last_created_at, *last_rank = page_rows[-1]
        next_cursor = _encode_cursor(
            snapshot_at,
            last_created_at,
            last_kind,
            last_id,
            filter_hash,
            sort_order=sort_order,
            workflow_rank=last_rank[0] if last_rank else None,
            order_snapshot_hash=order_snapshot_hash,
        )

    matching_counts = _review_record_counts(session, combined)
    summary_counts = (
        matching_counts
        if summary_combined is combined
        else _review_record_counts(session, summary_combined)
    )
    if sort_order == "oldest_waiting" and _review_order_snapshot_hash(session, combined) != order_snapshot_hash:
        _report_review_order_changed()
    return {
        "items": items,
        "next_cursor": next_cursor,
        "has_more": has_more,
        "page_size": page_size,
        "sort_order": sort_order,
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
