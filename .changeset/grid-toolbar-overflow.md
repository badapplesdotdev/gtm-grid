---
"@gtmgrid/desktop": patch
---

Grid toolbar: collapse action buttons into a "⋯" overflow menu on narrow widths.

When the toolbar is squeezed — e.g. the agent panel open beside the grid — the
action buttons (Dedupe, Webhook, Export CSV, Add row) used to crowd together and
the long table name wrapped onto multiple lines. The toolbar now measures its own
width (via a `ResizeObserver` `useElementWidth` hook) and, below a threshold,
folds those actions into a single overflow menu while keeping the primary Run
button and the LIVE/presence status inline. The table name also truncates with an
ellipsis instead of wrapping. Covered by unit tests for the hook and Electron E2E
tests for the wide/compact layouts and the overflow menu.
