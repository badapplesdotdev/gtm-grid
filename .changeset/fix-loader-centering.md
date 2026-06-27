---
"@gtmgrid/desktop": patch
---

Fix the loading screen no longer being centered (logo stuck at the top, label
floating in the middle). The previous release made `.app-shell` a CSS grid for the
Windows layout fix, but the loader and error screens borrow `.app-shell` for their
full-viewport sizing — so they inherited the grid and their centered content got
unstacked. They now keep their own flex centering.
