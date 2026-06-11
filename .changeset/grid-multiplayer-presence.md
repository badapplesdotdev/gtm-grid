---
"@gtmgrid/desktop": minor
"@gtmgrid/services": patch
---

Add live multiplayer presence to the cloud grid. You can now see who else is in a
table in real time:

- **Live users avatar stack** in the grid toolbar — everyone currently viewing the
  table, with their profile photo (or initials), capped at 5 with a **"+N more"**
  overflow. Hover an avatar to see the member's name.
- **Cell cursors** — each other member's selected cell gets a colored ring and a
  small avatar chip (Airtable-style), so you can see where teammates are working.
- **Editing indicator** — a member actively editing a cell shows a pulsing ring.
- **Follow a teammate** — click their avatar to jump the grid to their current cell.

Presence rides the existing per-table PartyKit channel (no extra connection) and
each member's name/photo come from the workspace (the `me`/`listMembers` APIs now
expose the user's avatar image). Built on shadcn/ui avatar + tooltip primitives.
