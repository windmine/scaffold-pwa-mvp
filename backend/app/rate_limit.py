from collections import defaultdict, deque
from dataclasses import dataclass
from threading import Lock
from time import monotonic

from fastapi import Request
from fastapi.responses import JSONResponse


@dataclass(frozen=True)
class RateLimitRule:
    name: str
    requests: int
    window_seconds: int
    path_prefixes: tuple[str, ...] = ()


class InMemoryRateLimiter:
    def __init__(
        self,
        *,
        enabled: bool,
        default_rule: RateLimitRule,
        rules: list[RateLimitRule] | None = None,
        exempt_paths: set[str] | None = None,
    ):
        self.enabled = enabled
        self.default_rule = default_rule
        self.rules = rules or []
        self.exempt_paths = exempt_paths or set()
        self._hits = defaultdict(deque)
        self._lock = Lock()

    def check(self, request: Request):
        if not self.enabled:
            return None

        path = normalized_path(request.scope.get("path", ""))
        if path in self.exempt_paths:
            return None

        rule = self._rule_for_path(path)
        if rule.requests <= 0 or rule.window_seconds <= 0:
            return None

        now = monotonic()
        cutoff = now - rule.window_seconds
        key = (rule.name, client_ip(request))

        with self._lock:
            hits = self._hits[key]
            while hits and hits[0] <= cutoff:
                hits.popleft()

            if len(hits) >= rule.requests:
                retry_after = max(1, int(rule.window_seconds - (now - hits[0])))
                return JSONResponse(
                    {
                        "detail": "Too many requests. Please wait and try again.",
                        "retry_after_seconds": retry_after,
                    },
                    status_code=429,
                    headers={
                        "Retry-After": str(retry_after),
                        "X-RateLimit-Limit": str(rule.requests),
                        "X-RateLimit-Window": str(rule.window_seconds),
                    },
                )

            hits.append(now)

        return None

    def _rule_for_path(self, path: str):
        for rule in self.rules:
            if any(path.startswith(prefix) for prefix in rule.path_prefixes):
                return rule
        return self.default_rule


def normalized_path(path: str):
    return path[4:] if path.startswith("/api/") else path


def client_ip(request: Request):
    forwarded_for = request.headers.get("x-forwarded-for", "")
    first_forwarded = forwarded_for.split(",", 1)[0].strip()
    if first_forwarded:
        return first_forwarded

    real_ip = request.headers.get("x-real-ip", "").strip()
    if real_ip:
        return real_ip

    return request.client.host if request.client else "unknown"
