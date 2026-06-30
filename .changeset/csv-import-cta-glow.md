---
"@gtmgrid/desktop": patch
---

Draw the eye to the next step on CSV import. On the "Map your columns" review
screen, the primary **Create table** button now pulses with an accent glow and an
arrow nudges toward it while the button is actionable — making the action to
proceed obvious after a drop/upload. The effect pauses on hover, only shows while
the button is enabled (hidden mid-import), and is disabled under
`prefers-reduced-motion`. Covered by a new Electron E2E spec (`csv-import-cta`)
asserting the glow/arrow appear and animate on review, are scoped to that step,
and respect reduced-motion.
