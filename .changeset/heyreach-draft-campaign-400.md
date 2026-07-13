---
"@gtmgrid/engine": patch
---

Turn HeyReach's "add leads to a draft campaign" 400 into an actionable message. Pushing leads into a HeyReach campaign that hasn't been activated yet returns an upstream business-rule 400, which the connector runtime previously re-threw raw so it surfaced as an unhandled exception. It now maps to guidance telling the user to activate the campaign first, matching how the 401 case is already handled.
