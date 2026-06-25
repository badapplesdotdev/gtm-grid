---
"@gtmgrid/analytics": patch
"@gtmgrid/auth": patch
---

Track new signups server-side. Better Auth account creation now captures a
`user_signed_up` PostHog event from the `user.create.after` hook, keyed on the
user id (the same distinct id the desktop client identifies with) and `$set`ting
the person's email/name. Previously a signup only became an identified person if
and when the desktop client's identify bridge ran, so accounts created without
that (older build, analytics disabled, web/invite-only flows) stayed anonymous.
