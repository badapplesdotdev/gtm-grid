/**
 * The `realtime` tRPC router — mints the WORKSPACE-SCOPED token the desktop/web
 * client uses to open a server-gated PartyKit grid connection (TRI-3261).
 *
 * `realtime.token` is a `workspaceProcedure` (input `{ workspaceId }`): the
 * middleware asserts the caller is a MEMBER of the workspace BEFORE the body
 * runs, so a non-member is rejected with FORBIDDEN and can never obtain a token
 * for a workspace they do not belong to. The body then mints a token
 * `{ sub: userId, workspaceId, exp }` signed with `PARTY_AUTH_SECRET`
 * (`@gtmgrid/auth` `mintPartyToken`) and returns it alongside the PartyKit URL.
 *
 * This fixes the option-a leak: the old `protectedProcedure` minted a token with
 * NO workspace claim, so any signed-in user could subscribe to any workspace's
 * public Supabase channel. Now the token BINDS to one workspace and the party's
 * `onBeforeConnect` rejects unless the token's `workspaceId` equals the room's.
 *
 * Membership is verified by the middleware (an Effect), but the token mint itself
 * is a pure off-context sign — no DB, no services — so the body just returns the
 * token + url.
 */

import { mintPartyToken, PARTY_TOKEN_TTL_SECONDS } from "@gtmgrid/auth";
import { router, workspaceProcedure } from "../trpc";

/**
 * The base URL of the PartyKit deployment the client connects to. Local dev
 * serves `partykit dev` on :1999 (`PARTY_URL=http://127.0.0.1:1999`).
 */
const partyUrl = (): string => process.env.PARTY_URL ?? "";

export const realtimeRouter = router({
  /**
   * Mint a short-lived WORKSPACE-SCOPED PartyKit token for the current member.
   * The client passes it as `?token=` to `subscribeToGrid`; the party authorizes
   * the connection only if the token's `workspaceId` matches the room. Expires in
   * {@link PARTY_TOKEN_TTL_SECONDS}; the client re-fetches before expiry.
   *
   * `workspaceProcedure` has already asserted membership of `input.workspaceId`,
   * so reaching this body means the caller is authorized for that workspace.
   */
  token: workspaceProcedure.mutation(async ({ ctx, input }) => {
    const token = await mintPartyToken({
      userId: ctx.userId,
      workspaceId: input.workspaceId,
    });
    return {
      token,
      url: partyUrl(),
      expiresInSeconds: PARTY_TOKEN_TTL_SECONDS,
    };
  }),
});
