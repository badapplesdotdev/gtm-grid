---
"@gtmgrid/desktop": patch
---

Fix extension and AI-provider config panels not opening when a cloud workspace
is selected. They were gated behind `!inCloud`, so the cloud grid always owned
the main area and clicking a connector did nothing — and the shared "Workspace"
credential scope (cloud key-sharing) was unreachable. The panels now render in
both local and cloud workspaces, and the view returns to the grid on any
cloud-table select/create.
