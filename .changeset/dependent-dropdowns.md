---
"@gtmgrid/desktop": patch
---

fix(connectors): pass sibling field values to dependent dropdowns. A connector dropdown whose option source requires a parent field (e.g. a PlusVibe campaign list that needs `workspace_id`) now receives the in-progress sibling values from the column editor, so it loads instead of failing with a raw upstream 400. The injection is generic — keyed off each source method's own required schema — and surfaces a clear "Select <field> first" prompt when a required parent is still unset.
