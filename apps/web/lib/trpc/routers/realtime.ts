/**
 * The `realtime` tRPC router — mints the Supabase-compatible JWT the desktop/web
 * client uses to authorize a Supabase Realtime connection (TRI-3251).
 *
 * `realtime.token` is a `protectedProcedure`: it requires a Better Auth session
 * and returns an HS256 JWT (signed with `SUPABASE_JWT_SECRET`) carrying the
 * caller's user id, via `@gtmgrid/auth` `mintSupabaseJwt`. The token authorizes
 * the Realtime SOCKET only — NO RLS — so the client can subscribe to its
 * workspace's grid channels; all reads/writes still go through tRPC (the channel
 * carries only broadcast change events + presence).
 *
 * This procedure does not run an Effect (no DB, no services) — it just signs a
 * token off the authenticated `ctx.userId`, so it is the simplest possible
 * protected procedure.
 */

import { mintSupabaseJwt, SUPABASE_JWT_TTL_SECONDS } from "@gtmgrid/auth";
import { protectedProcedure, router } from "../trpc";

export const realtimeRouter = router({
  /**
   * Mint a short-lived Supabase-compatible JWT for the current user. The client
   * passes it to the Supabase Realtime client (`subscribeToGrid`) to authorize
   * the connection. Expires in {@link SUPABASE_JWT_TTL_SECONDS}; the client
   * re-fetches before expiry.
   */
  token: protectedProcedure.mutation(async ({ ctx }) => {
    const token = await mintSupabaseJwt({ userId: ctx.userId });
    return { token, expiresInSeconds: SUPABASE_JWT_TTL_SECONDS };
  }),
});
