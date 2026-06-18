---
"@gtmgrid/server": patch
---

Drive the Browse-all gallery's "featured" tools from a code-level constant (`FEATURED_TOOLS`) read by `/api/extensions`, instead of each manifest's persisted `featured` db flag. `seedExtensions()` upserts manifests on boot but never prunes rows whose manifest left disk, so checking out a feature branch seeded stray `featured: true` rows that lingered after switching back — making tools show as featured locally but not on prod. The featured set is now identical everywhere and can't drift with stale local db state; the dead `featured` manifest field is removed.
