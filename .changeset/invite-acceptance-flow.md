---
"@gtmgrid/desktop": patch
---

Fix + polish the team-invite acceptance flow:

- **Not-authed invites now guide sign-up.** A `gtmgrid://invite/<token>` deep link
  (or `?invite=` URL) is captured into a pending-invite store; while signed out it
  FORCES the sign-in/sign-up flow even if the user previously chose "continue
  locally", so an invitee is always routed to create an account and is then
  auto-enrolled. Previously the app opened in local state and never prompted.
- **Celebrate on join** — accepting an invite (banner or new-signup auto-enrol)
  fires confetti + a confirmation dialog and refreshes app state (plan, badge,
  cloud tables) so everything is immediately in sync.
