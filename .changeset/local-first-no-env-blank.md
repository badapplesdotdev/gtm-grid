---
"@gtmgrid/desktop": patch
---

Fix blank screen on local-only builds with no cloud env vars. `App` always calls
react-query hooks (`useMe`, etc.), but `CloudProvider` only mounted the
`QueryClientProvider` when `VITE_API_URL` was set — so a no-env build threw
"No QueryClient set" during render and white-screened the whole app (the exact
state OSS users hit). The provider is now mounted unconditionally (it makes zero
network calls in local mode), and a top-level error boundary keeps the window
non-blank if any future render error occurs.
