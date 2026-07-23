---
"@gtmgrid/services": minor
"@gtmgrid/desktop": minor
"@gtmgrid/web": minor
---

Delete a saved connector key, instead of only being able to replace it.

`credentials` exposed only list/save/getForRun, and `save` upserts — so a key
could be swapped for another but never removed, and the desktop's empty-value
guard meant it could not even be blanked. `CredentialRepo.remove` existed but was
wired solely to the OAuth disconnects, so a plain API key, once saved into a
workspace, stayed until the workspace itself was deleted.

That matters when a workspace was seeded with one person's keys and its members
now want to supply their own: any connector left un-replaced kept the old row,
which read as "connected" in the panel while failing at run time.

- `credentials.remove` deletes the row. Shared (`workspace`) keys are owner/admin
  only, matching the Slack/CRM disconnect: deleting one stops every other
  member's columns for that connector and cannot be undone without the secret.
  Saving stays member-level, because a replace leaves a working key behind.
- `personal` keys always resolve to the caller's own row, so a member can delete
  theirs and can never name someone else's.
- The desktop connection panel gains a Remove button beside Replace, behind a
  confirmation, shown only to owner/admin.

Note that removing a shared key does not retract it: any member could read it in
plaintext while it was stored, so a key that has been shared should also be
rotated at the provider.
