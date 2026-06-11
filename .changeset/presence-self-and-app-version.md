---
"@gtmgrid/desktop": patch
---

Cloud grid niceties:

- **You now appear in the presence avatar stack** (labeled "you"), so you can see
  at a glance that you're connected — even when you're the only one in the table.
  Your own selected cell is still left un-ringed; only teammates' cells get a
  presence cursor.
- **The app version is shown** at the bottom of the account menu ("GTM Grid
  vX.Y.Z"), so it's easy to tell which build you're on.
- **Cloud data refreshes when you return to the app** — queries now refetch on
  window focus (gated by a 30s stale time), so tables, integration keys, and other
  changes made elsewhere or by teammates show up without restarting the app.
