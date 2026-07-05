---
"@gtmgrid/desktop": patch
---

CRM sync fixes from the first live Attio connection.

- A missing Attio scope now pauses the sync with a clear "Reconnect
  Attio" banner instead of silently completing with zero records.
- New "Reconnect" link on the wizard's connected banner, so re-granting
  scopes or refreshing the authorization never requires revoking the app.
- Reference-name lookups tolerate Attio rejecting bulk id filters.
- "Connect with Attio" button renders icon and label on one row.
