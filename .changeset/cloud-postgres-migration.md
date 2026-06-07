---
"@gtmgrid/desktop": minor
---

Migrate the cloud tier off Convex to Supabase Postgres + Drizzle + Better Auth + tRPC, with server-gated PartyKit realtime (multiplayer). The desktop app now talks to the tRPC API + Better Auth instead of Convex; the local-first SQLite engine is unchanged. Also adds a platform-aware download experience to the marketing site.
