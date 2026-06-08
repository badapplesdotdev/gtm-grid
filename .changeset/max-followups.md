---
"@gtmgrid/desktop": patch
---

Tools & agent follow-ups: add Firecrawl (scraping) and Supabase (Management API)
connectors with manifests + agent playbooks; restyle the agent composer (model
picker popover, send/stop icon); persist the per-agent model selection across
relaunches; cap each sidebar section (Tools/Skills/Functions) at 10 with a
"+ N more" reveal; and rebuild the marketing homepage (apps/web). Past agent
conversations now rely on each CLI's own native transcript store (resume via the
native session id) rather than a local copy.
