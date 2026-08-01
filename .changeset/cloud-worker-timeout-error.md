---
"@gtmgrid/desktop": patch
"@gtmgrid/server": patch
---

Turn an exhausted cloud-worker request timeout into a clear, dedup-friendly typed error instead of leaking the raw `DOMException: This operation was aborted`. When all retry attempts to a `/api/worker/*` route abort on the per-attempt timeout, `fetchWithRetry` now throws a typed `HttpTimeoutError` ("worker request timed out after N attempt(s)"), so error tracking classifies transient worker timeouts distinctly rather than surfacing an opaque FiberFailure.
