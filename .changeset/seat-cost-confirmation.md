---
"@gtmgrid/desktop": patch
"@gtmgrid/web": patch
"@gtmgrid/services": patch
---

Confirm the new price before an invite that adds a billable seat. New
`billing.previewSeatChange` (backed by `AutumnClient.previewSeatChange` →
Autumn `previewUpdate`, reading the recurring next-cycle total) returns the
projected `{ seats, total, currency }` for the workspace's current members + 1.
The desktop's Workspace settings invite flow now shows an "Add a seat?"
confirmation with the new monthly price; the invite only sends on confirm.

Also fixes the apps/web build for the trial-reminders Inngest job (the
`send-trial-reminders` function used the wrong `createFunction` arity and apps/web
was missing the `@gtmgrid/email` dependency — neither is caught by the root
`tsc -b`, only by `apps/web`'s own typecheck / the Vercel build).
