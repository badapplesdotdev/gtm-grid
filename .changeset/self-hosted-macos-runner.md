---
"@gtmgrid/desktop": patch
---

Build macOS releases on a self-hosted Apple-silicon runner.

The two macOS targets now build on the self-hosted Mac mini (runs-on:
[self-hosted, macOS]) instead of GitHub-hosted macOS runners, so the lengthy
Apple notarization waits no longer consume GitHub-hosted macOS minutes. Linux
and Windows continue to build on GitHub-hosted runners. No change to the shipped
app.
