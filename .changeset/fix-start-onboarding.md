---
"@gtmgrid/desktop": patch
"@gtmgrid/server": patch
---

Make the `/start` onboarding command actually work, and drop `/help`. Previously
both were forwarded to the agent CLI, which intercepted them as its OWN built-in
slash commands ("Unknown command: /start", "/help isn't available"). GTM Grid now
answers `/start` itself with a local onboarding tour and never forwards it to the
CLI. The dead onboarding instructions are removed from the agent system preamble.
