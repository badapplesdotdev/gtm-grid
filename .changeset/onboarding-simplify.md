---
"@gtmgrid/desktop": patch
---

Simplify onboarding to Workspace → Team. The Plan-selection and AI-key steps are
removed from the flow (every new workspace is auto-enrolled in the Team trial on
creation, and the AI key can be added later); both screens are kept in code but
unreachable. After onboarding finishes, app state is refreshed (react-query
invalidate + Autumn plan sync) so the plan/badge/cloud tables are immediately in
sync. Also: the root `typecheck` script now runs `apps/web`'s typecheck (it was
skipped, which let a web-only type error merge + break the Vercel build).
