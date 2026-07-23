---
"@gtmgrid/services": minor
"@gtmgrid/desktop": minor
"@gtmgrid/web": minor
---

Let the workspace owner assign roles and transfer ownership.

Roles (`owner | admin | member`) were write-once: set at invite time and frozen,
with the desktop hardcoding `member` on every invite. There was no way to make an
existing teammate an admin, and no way to move ownership at all.

- `workspaces.updateMemberRole` (owner-only) changes any other member between
  `admin` and `member`, and the roster in workspace settings gains a role picker.
- Setting someone to `owner` TRANSFERS ownership: they become owner, the caller
  drops to admin, and `workspaces.ownerId` follows — one transaction, so `ownerId`
  can never disagree with the member roles. That split would strand billing (the
  Autumn customer profile and trial emails resolve from `ownerId`) and workspace
  deletion. The outgoing owner keeps admin rather than being dropped.
- The owner cannot demote themselves (`LastOwnerError`), so a workspace is never
  left owner-less; transferring is the only way out.
- Invites can no longer be used to sidestep that rule. Granting `admin` by
  invitation now requires `owner` — an admin could otherwise mint fellow admins —
  and `owner` is refused outright, since ownership is single-holder and moves only
  by transfer.
