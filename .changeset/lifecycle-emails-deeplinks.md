---
"@gtmgrid/desktop": minor
---

Lifecycle email system + deep links into the app.

- 13 lifecycle emails (#8–#20 from the activation-sequence design): activation
  nudges, run-finished / new-signals status emails, weekly digest, dormant
  re-engagement, trial win-back, dunning, credit warning, teammate-joined and
  subscription receipts — all behind the `LIFECYCLE_EMAILS_ENABLED` kill-switch
  with per-category unsubscribe and four-layer send idempotency.
- Email CTAs deep-link into the desktop app via the new `/open` bounce page and
  `gtmgrid://open/<destination>` routing: specific tables, the new-table
  chooser, AI-provider settings, invite/members and billing.
- Desktop: presence heartbeat (`users.last_active_at`) powering the email
  presence gates; dev runs no longer register the `gtmgrid://` scheme on macOS
  (a dev launch could hijack deep links from the installed app system-wide).
