---
"@gtmgrid/desktop": patch
---

polish(desktop): interface detail pass across the grid app

Small craft fixes that compound into a more polished feel, all in the
hand-rolled CSS design system (`styles.css` + onboarding `onboarding.css`):

- **Tactile buttons**: `.btn` now gives a subtle `scale(0.96)` press feedback,
  guarded by `prefers-reduced-motion`.
- **Tabular numbers**: live-updating counts (row/col meta, selection count,
  sidebar table counts, connector method counts, notification badge, bulk-select
  count) use `font-variant-numeric: tabular-nums` so they no longer shift width
  as digits change.
- **Specific transitions**: replaced four `transition: all` declarations
  (schedule buttons, output-type picker, formula generate button, onboarding
  step dots) with explicit property lists.
- **Image edges**: rendered markdown images in the agent panel get a subtle 1px
  ring (pure black/white at low opacity, light/dark aware) via `box-shadow` so it
  tracks the border radius.
- **Text wrapping**: large display headings (onboarding screen title, CSV import
  title, perks title) use `text-wrap: balance`; descriptive subtext uses
  `text-wrap: pretty` to avoid orphans.
