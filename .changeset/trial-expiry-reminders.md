---
"@gtmgrid/desktop": patch
"@gtmgrid/web": patch
"@gtmgrid/services": patch
---

Proactively prompt users to upgrade before the 7-day trial hard-locks the cloud:

- **In-app countdown banner**: a new `workspaces.trialEndsAt` column is synced from
  Autumn (`getActiveSubscriptions`) by `syncPlan` and seeded on trial start; `me`
  surfaces it, and the desktop shows a "Your trial ends in N days — upgrade" banner
  (escalating in the last 2 days) with the Autumn checkout CTA.
- **Email reminders**: a daily Inngest job (`send-trial-reminders`) scans trials via
  `WorkspaceRepo.findTrialsEndingBetween` using two disjoint one-day windows
  (~2 days left, last day) so each milestone emails the owner exactly once (no
  reminder-stage column), and sends the new `trialEndingEmail` via Resend. No-op
  when email is unconfigured.

Verified end-to-end against local Postgres + dev Autumn: trialEndsAt seeded on
create, reconciled by syncPlan from Autumn, surfaced in me, and found by the scan.
