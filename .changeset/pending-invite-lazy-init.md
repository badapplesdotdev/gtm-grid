---
"@gtmgrid/desktop": patch
---

Refactor: read the launch invite token via lazy `useState` init instead of a
mount `useEffect` in PendingInvites — fewer effects, more declarative.
