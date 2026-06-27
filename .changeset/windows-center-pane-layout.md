---
"@gtmgrid/desktop": patch
---

Fix the center content pane collapsing to content size on Windows. The "No table
selected" empty state and the CSV "Map your columns" review sat in a small band
with large empty gaps instead of filling the pane (macOS was fine). The app shell
now uses a CSS grid (`grid-template-rows: auto 1fr`) so the main row gets a
definite height that WebView2 propagates to the nested `flex:1` panes — plain
flex-column stretch did not. The optional invite banner still takes its own row,
so the pane correctly fills the remaining height when it shows.
