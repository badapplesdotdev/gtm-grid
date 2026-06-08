---
"@gtmgrid/cloud": patch
"@gtmgrid/services": patch
"@gtmgrid/desktop": patch
---

New-signup onboarding: auto-enrol every new workspace in a 7-day, no-card **Team
free trial** so owners can invite teammates from day one (least-friction), and
auto-enrol invited users instead of prompting them to create their own workspace.

- `createWorkspace` now starts a Team trial in Autumn (`SeatsService.startTrial` →
  `attach` with `customize.freeTrial` (7 days, `cardRequired: false`) + a prepaid
  seat grant, since the Team plan's seats are prepaid). Best-effort: a billing
  hiccup never blocks workspace creation. When the trial lapses with no card, the
  workspace returns to Free and inviting then requires an upgrade.
- The plan badge reflects the trial (trialing subscriptions count as active in
  `getActivePlanIds`).
- Desktop: a fresh signup with a pending (email-matched) invite is auto-enrolled
  into that workspace instead of being shown the create-workspace wizard; accepting
  an invite now also refetches `me` so the joined workspace appears immediately.

Verified end-to-end against the dev Autumn sandbox + local Postgres (trial attach,
seat availability, plan sync, invite-during-trial, and invite→signup→auto-enrol).
