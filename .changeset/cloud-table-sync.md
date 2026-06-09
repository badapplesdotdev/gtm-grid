---
"@gtmgrid/desktop": minor
---

Cloud table sync, agent environment routing, notification center, plus agent + security hardening.

- **Sync local tables to your cloud workspace**: per-table status dots, a sync popover (push / progress / overwrite-confirm), a "Sync all" control, and an opt-in **auto-sync** setting (default off) with an enable-time overwrite warning and a dismissible nudge. One-way push (local is the source of truth); re-sync is **atomic** (create-new-then-swap) so a failed push never destroys the cloud copy, and every overwrite is explicitly confirmed.
- **Agents on the right environment**: in cloud mode the in-app Claude/Codex agents' table tools read *and* write the cloud (Supabase) project instead of the local SQLite one (new worker routes back the write tools, gated by membership + cloud-actions quota).
- **Notification center**: a bell with an unread badge consolidates the trial / auto-sync / update alerts — no more stacked full-width banners.
- **Reliability**: agent CLI process trees are reliably terminated on turn end (fixes a multi-GB memory leak), and agent turns no longer abort on unrelated re-renders.
- **Security hardening**: every sidecar route is gated on a loopback Host + allowed Origin; SSRF protection blocks server-side connector calls to private hosts; and the QuickJS sandbox enforces the connector allow-list inside the host bridge.
