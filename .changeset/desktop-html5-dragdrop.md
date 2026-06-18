---
"@gtmgrid/desktop": patch
---

Re-enable in-app HTML5 drag-and-drop (drag tables into sidebar folders, CSV file-drop import). Tauri's webview intercepts OS-level drag-drop by default (`dragDropEnabled`), which swallowed all HTML5 `dragover`/`drop` events inside the app. The app uses only HTML5 DnD with no Tauri-native drop handlers, so disabling Tauri's interception safely restores folder filing for local and cloud tables plus CSV drop import.
