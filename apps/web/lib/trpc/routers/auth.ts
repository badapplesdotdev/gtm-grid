/**
 * The `auth` tRPC router — the W4 port of the Convex public query
 * `auth.enabledProviders` (convex/auth.ts:153).
 *
 * It exposes ONE public, booleans-only query the desktop UI reads to decide which
 * OAuth buttons to render and whether to show the email-verification /
 * forgot-password steps. The values come from the pure, env-derived
 * `enabledProviders()` in `@gtmgrid/auth` (which itself returns booleans only,
 * never a client id or secret), so this procedure needs no DB, no Effect runtime,
 * and no session — it mirrors the Convex query's public, side-effect-free shape.
 *
 * Collapsing the Convex action/query split: the Convex deployment surfaced this
 * as a reactive public query; here it is a single stateless `publicProcedure`
 * read, testable via `createCaller` with no live backend.
 */

import { type EnabledProviders, enabledProviders } from "@gtmgrid/auth";
import { publicProcedure, router } from "../trpc";

export const authRouter = router({
  /**
   * Which auth providers/flows are enabled on this deployment, as BOOLEANS ONLY.
   * Public (no session needed) because the sign-in UI reads it before any user
   * is authenticated; never returns secrets. Mirrors the desktop
   * `EnabledProviders` shape (cloud/auth.ts) exactly so `useEnabledProviders`
   * binds without a transform.
   */
  enabledProviders: publicProcedure.query((): EnabledProviders =>
    enabledProviders(),
  ),
});
