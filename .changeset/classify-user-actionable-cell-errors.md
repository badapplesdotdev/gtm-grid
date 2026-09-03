---
"@gtmgrid/engine": patch
---

Classify user-actionable cell run failures (expired login, no credits, connector not configured) so they show a clear cell error — with a re-authenticate prompt for auth — but stay off error tracking. Only genuine defects now raise an exception, and a failed dispatch surfaces the original connector error instead of an opaque `FiberFailure`.
