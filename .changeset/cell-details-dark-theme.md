---
"@gtmgrid/desktop": patch
---

Fix the cell-details (field mapping) drawer in dark mode: the panel kept a
hardcoded light backdrop while its title, pills, and footer used dark-theme
colors — making the title invisible and the panel clash with the app. The
drawer now uses theme tokens throughout, and the number/boolean type glyphs
brighten on dark for contrast.
