---
"@gtmgrid/desktop": patch
---

Render the agent chat with Streamdown so assistant replies get proper markdown
— GFM tables, lists, code fences and inline formatting — streamed safely as
incomplete tokens arrive (replacing the hand-rolled renderer). Typography is
scoped to the copilot panel so headings stay small and bold rather than
prose-sized. Tool calls now interleave with text in the order the agent emits
them, instead of bunching every tool call above the reply.
