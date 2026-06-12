---
"@gtmgrid/desktop": patch
"@gtmgrid/services": patch
---

Agent presence (Co-Pilot cursor): the in-app AI agent now appears in cloud
tables like a teammate. As it reads or writes — get_table, run_column,
update_cells, add_rows — the grid shows "<Your name>'s Agent" in the avatar
stack (bot glyph, brand-accent ring), rings the cell or column it's working
on, and labels the activity ("reading the table", "updating 2 cells",
"running Email"). Visible to everyone in the table's room, clears when the
turn ends. Works against the already-deployed realtime party.
