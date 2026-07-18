/**
 * `slack` tRPC router — connect / status / disconnect for a workspace's Slack
 * connection (TRI: slack).
 *
 * A SEPARATE router, not three more procedures on `crm`. Widening `crm`'s
 * `provider` enum to include "slack" would have routed `connectionStatus` into
 * `CrmConnectionService` — the wrong service entirely — and offered Slack to
 * every CRM-sync procedure (`listSources`, bindings, sync runs) that has no
 * meaning for it. Slack is a connector the engine calls, not a sync source.
 *
 * The two OAuth-shaped procedures still share the provider-agnostic adapter, so
 * the duplication is data, not logic.
 */

import { MembershipService, type SlackConnection, SlackConnectionService } from "@gtmgrid/services";
import { Effect, Option } from "effect";
import { z } from "zod";
import { authorizeUrlWithState, SLACK_OAUTH } from "../../crm/oauth-providers";
import { protectedProcedure, router, runEffect } from "../trpc";

export const slackRouter = router({
  /**
   * Whether Slack is CONFIGURED on this deployment (client id/secret present)
   * and CONNECTED for this workspace. Two different things: a self-hosted
   * instance with no Slack app is "not configured", and the UI should say so
   * rather than offering a Connect button into a broken handshake.
   */
  connectionStatus: protectedProcedure
    .input(z.object({ workspaceId: z.string().min(1) }))
    .query(({ ctx, input }) =>
      runEffect(
        ctx.runtime,
        
        Effect.gen(function* () {
          const membership = yield* MembershipService;
          yield* membership.requireMember(input.workspaceId);
          // `isConfigured` reads env only — its error channel is `never`, so it
          // needs no handling and cannot be the thing a catch here is for.
          const configured = yield* SLACK_OAUTH.isConfigured();
          const connection = yield* SlackConnectionService;
          const conn = yield* connection.memberConnection(input.workspaceId).pipe(
            // Degrade EXACTLY ONE failure, and only this far.
            //
            // A stored credential that won't decrypt is genuinely unusable, and
            // "Not connected" (with a working Connect button) is the honest, and
            // fixable, rendering of that. Everything else in `GetForRunError`
            // propagates: `CredentialAuthzError` is authz and belongs as a 403,
            // and `CredentialRepoError` is a transient DB fault the operator
            // needs to SEE.
            //
            // Note `configured` is already resolved above and survives untouched,
            // which is the whole point — see below.
            Effect.catchTag("DecryptError", () => Effect.succeed(Option.none<SlackConnection>())),
          );
          return Option.match(conn, {
            onNone: () => ({ configured, connected: false as const }),
            onSome: (c) => ({
              configured,
              connected: true as const,
              connectedByName: c.meta.connectedByName,
              teamName: c.meta.teamName,
              teamId: c.meta.teamId,
            }),
          });
        }),
        // NO blanket `Effect.catchAll(() => ({ configured: false, ... }))` here.
        // It swallowed requireMember's NotAMemberError (a 403 became a cheerful
        // 200) and every transient DB fault, and then asserted `configured:
        // false` — which the desktop renders as "Slack isn't set up on this
        // deployment yet" AND uses to DISABLE the Connect button. So a five-second
        // DB blip on a fully configured deployment told the user their operator
        // never set Slack up, and left them no control to retry with. It also
        // defeated this router's own `runEffect`, whose entire job is mapping
        // typed failures to tRPC codes. `crm.connectionStatus` has no such catch;
        // this one was the anomaly.
      ),
    ),

  /**
   * The FULL Slack authorize URL with a state minted for the calling member.
   *
   * Minted HERE rather than in the browser because desktop auth is bearer-based:
   * an `openExternal` navigation carries no gtmgrid.dev session, so the web
   * authorize route's session gate would dead-end the flow. The signed state IS
   * the trust for the callback.
   */
  authorizeUrl: protectedProcedure
    .input(z.object({ workspaceId: z.string().min(1) }))
    .query(({ ctx, input }) =>
      runEffect(
        ctx.runtime,
        
        Effect.gen(function* () {
          const membership = yield* MembershipService;
          const member = yield* membership.requireMember(input.workspaceId);
          const url = yield* authorizeUrlWithState(SLACK_OAUTH, {
            workspaceId: input.workspaceId,
            userId: member.userId,
          });
          return { url };
        }),
      ),
    ),

  /**
   * Forget the connection. Local delete only — no Slack-side `auth.revoke`,
   * matching the CRM disconnect: revoking would also kill any other
   * installation sharing the grant, and a user who wants that can uninstall the
   * app from Slack directly.
   */
  disconnect: protectedProcedure
    .input(z.object({ workspaceId: z.string().min(1) }))
    .mutation(({ ctx, input }) =>
      runEffect(
        ctx.runtime,
        
        Effect.gen(function* () {
          const membership = yield* MembershipService;
          yield* membership.requireMember(input.workspaceId);
          const connection = yield* SlackConnectionService;
          const removed = yield* connection.disconnect(input.workspaceId);
          return { removed };
        }),
      ),
    ),
});
