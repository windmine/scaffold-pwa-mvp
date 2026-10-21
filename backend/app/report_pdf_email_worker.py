"""Bounded dispatcher for an approved scheduled runtime; never run by the API."""
import argparse
import json


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--limit", type=int, default=10, choices=range(1, 51), metavar="1..50")
    args = parser.parse_args()
    from app.config import REPORT_PDF_EMAIL_WORKER_ENABLED
    if not REPORT_PDF_EMAIL_WORKER_ENABLED:
        print(json.dumps({"status": "disabled"}))
        return 0
    try:
        from app.database import engine, verify_database_migrations
        from app.use_cases.report_pdf_email import dispatch_pending
        verify_database_migrations()
        counts = dispatch_pending(engine, limit=args.limit)
        print(json.dumps({"status": "completed", "counts": counts}))
        return 0
    except Exception:
        # Never dump DB URLs, SQL parameters, SMTP responses, recipient or PDF.
        print(json.dumps({"status": "blocked", "reason": "Inspect configuration and durable outbox status; do not reset attempts."}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
