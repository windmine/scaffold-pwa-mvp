"""Explicit, database-free write pause for a coordinated migration cutover.

Not the default API entrypoint. Run only as a temporary Cloud Run revision;
normal application startup and readiness checks must never be bypassed.
"""
from fastapi import FastAPI
from fastapi.responses import JSONResponse


app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)


@app.get("/health")
@app.get("/api/health")
def liveness():
    return {"status": "maintenance"}


@app.api_route("/{path:path}", methods=["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
def maintenance(path: str):
    return JSONResponse(
        status_code=503,
        content={"detail": "Service update in progress. Please keep your draft and try again shortly."},
        headers={"Retry-After": "60", "Cache-Control": "no-store"},
    )
