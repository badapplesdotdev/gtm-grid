---
"@gtmgrid/desktop": minor
---

Full keyboard accessibility for the desktop app

- Spreadsheet-style grid navigation: arrow keys, Home/End, Cmd/Ctrl+Arrow, PageUp/PageDown, roving tabindex, `role="grid"` + ARIA indices, with scroll-into-view that survives row/column virtualization.
- Type-to-edit (any character), Enter/F2 to edit, Escape to cancel, with focus returning to the cell; Space / Shift+Arrow / Cmd+A for row selection.
- Migrated every overlay to shadcn/Radix Dialog/Popover/Sheet primitives, so dialogs, popovers and drawers all close on Escape, trap focus, and restore focus to their trigger.
- Command palette (Cmd/Ctrl+K) for jumping to tables and common actions.
- Skip-to-content link and keyboard-focusable sidebar navigation (table rows, section/folder headers, provider/tool rows) with a global focus-visible ring.
