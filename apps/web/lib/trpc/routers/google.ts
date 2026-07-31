/**
 * `google` tRPC router — connect / status / pick / disconnect for a workspace's
 * Google connection.
 *
 * A SEPARATE router for the same reason `slack` is: widening `crm`'s `provider`
 * enum would route `connectionStatus` into `CrmConnectionService` and offer
 * Google to every CRM-sync procedure that has no meaning for it.
 *
 * It is `google`, not `googleSheets`. ONE grant serves every Google connector,
 * so connect/disconnect/status are properties of the ACCOUNT, not of Sheets. A
 * future `googleDocs` router would duplicate all three and let a user
 * "disconnect Docs" while Sheets kept working off the same row.
 *
 * The picked-file procedures ARE Sheets-flavoured today, but they are really
 * "which Drive files may we touch?" — a `drive.file` property of the grant, so
 * they belong here too.
 */

import {
  CrmSyncError,
  type GoogleConnection,
  GoogleConnectionService,
  MembershipService,
} from "@gtmgrid/services";
import { Effect, Option } from "effect";
import { z } from "zod";
import { captureServer } from "../../posthog-server";
import { authorizeUrlWithState, GOOGLE_OAUTH } from "../../crm/oauth-providers";
import { protectedProcedure, router, runEffect } from "../trpc";

/** One file as the Picker hands it back. Names are display-only. */
const pickedFile = z.object({
  id: z.string().min(1),
  name: z.string().default(""),
});

export const googleRouter = router({
  /**
   * Whether Google is CONFIGURED on this deployment (client id/secret present)
   * and CONNECTED for this workspace — plus how many spreadsheets are reachable.
   *
   * The file count is part of STATUS, not a separate query, because under
   * `drive.file` "connected" alone does not mean "usable": a workspace can hold
   * a perfectly valid grant that can open nothing. The card has to be able to
   * say so, or the user's next step ("why is my sheet not listed?") is invisible.
   */
  connectionStatus: protectedProcedure
    .input(z.object({ workspaceId: z.string().min(1) }))
    .query(({ ctx, input }) =>
      runEffect(
        ctx.runtime,
        Effect.gen(function* () {
          const membership = yield* MembershipService;
          yield* membership.requireMember(input.workspaceId);
          // `isConfigured` reads env only — error channel is `never`.
          const configured = yield* GOOGLE_OAUTH.isConfigured();
          const connection = yield* GoogleConnectionService;
          const conn = yield* connection.memberConnection(input.workspaceId).pipe(
            // Degrade EXACTLY ONE failure, and only this far. An undecryptable
            // credential is genuinely unusable, and "Not connected" with a working
            // Connect button is the honest, fixable rendering. Everything else in
            // `GetForRunError` propagates: `CredentialAuthzError` is a 403, and
            // `CredentialRepoError` is a transient fault the operator must SEE.
            //
            // Emphatically NOT a blanket `catchAll` returning `configured: false`.
            // The desktop renders that as "Google isn't set up on this deployment"
            // AND uses it to DISABLE the Connect button, so a five-second DB blip
            // would tell the user their operator never set Google up and leave
            // them nothing to retry with.
            Effect.catchTag("DecryptError", () => Effect.succeed(Option.none<GoogleConnection>())),
          );
          return Option.match(conn, {
            onNone: () => ({ configured, connected: false as const }),
            onSome: (c) => ({
              configured,
              connected: true as const,
              connectedByName: c.meta.connectedByName,
              googleEmail: c.meta.googleEmail,
              pickedFileCount: c.meta.pickedFiles.length,
            }),
          });
        }),
      ),
    ),

  /**
   * The spreadsheets this workspace has authorised, for the picker UI and the
   * sheet-import modal.
   *
   * Separate from `connectionStatus` because status is polled every 2s by the
   * connect card while this list is only needed when a chooser is open — and the
   * list is unbounded-ish where the count is one integer.
   */
  pickedFiles: protectedProcedure
    .input(z.object({ workspaceId: z.string().min(1) }))
    .query(({ ctx, input }) =>
      runEffect(
        ctx.runtime,
        Effect.gen(function* () {
          const membership = yield* MembershipService;
          yield* membership.requireMember(input.workspaceId);
          const connection = yield* GoogleConnectionService;
          const conn = yield* connection.memberConnection(input.workspaceId).pipe(
            Effect.catchTag("DecryptError", () => Effect.succeed(Option.none<GoogleConnection>())),
          );
          return {
            files: Option.match(conn, {
              onNone: () => [],
              onSome: (c) => [...c.meta.pickedFiles],
            }),
          };
        }),
      ),
    ),

  /**
   * The FULL Google authorize URL with a state minted for the calling member.
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
          const url = yield* authorizeUrlWithState(GOOGLE_OAUTH, {
            workspaceId: input.workspaceId,
            userId: member.userId,
          });
          return { url };
        }),
      ),
    ),

  /**
   * A signed, 15-minute URL for the Google Picker page.
   *
   * Same shape and same reasoning as `authorizeUrl`: the desktop opens this with
   * `openExternal`, so the browser carries no session and the SIGNED STATE is the
   * trust boundary. Minting it here — after `requireMember` — is what lets the
   * picker's API routes skip session resolution entirely.
   *
   * Reuses the OAuth state machinery rather than inventing a second token
   * format: it is already provider-bound, HMAC-signed, TTL'd and covered by
   * tests, and a parallel scheme would be a second thing to get wrong.
   */
  pickerUrl: protectedProcedure
    .input(z.object({ workspaceId: z.string().min(1) }))
    .query(({ ctx, input }) =>
      runEffect(
        ctx.runtime,
        Effect.gen(function* () {
          const membership = yield* MembershipService;
          const member = yield* membership.requireMember(input.workspaceId);
          const state = yield* GOOGLE_OAUTH.mintState({
            workspaceId: input.workspaceId,
            userId: member.userId,
          });
          if (state === null) {
            return yield* Effect.fail(
              new CrmSyncError({ message: "OAuth state signing unavailable (no BETTER_AUTH_SECRET)" }),
            );
          }
          const site = process.env.SITE_URL ?? "https://www.gtmgrid.dev";
          return { url: `${site}/google/picker?state=${encodeURIComponent(state)}` };
        }),
      ),
    ),

  /**
   * Record spreadsheets the user just authorised in the Google Picker.
   *
   * The Picker runs in the BROWSER holding a short-lived access token, so this is
   * how its result reaches the server. It is additive and idempotent: re-picking
   * an existing file refreshes its name rather than duplicating it, so a user who
   * opens the Picker twice does not lose their first selection.
   *
   * Returns `saved: false` when no connection exists — the honest answer if the
   * grant was revoked between opening the Picker and finishing with it.
   */
  addPickedFiles: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string().min(1),
        files: z.array(pickedFile).min(1).max(200),
      }),
    )
    .mutation(({ ctx, input }) =>
      runEffect(
        ctx.runtime,
        Effect.gen(function* () {
          const membership = yield* MembershipService;
          const member = yield* membership.requireMember(input.workspaceId);
          const connection = yield* GoogleConnectionService;
          const saved = yield* connection.addPickedFiles({
            workspaceId: input.workspaceId,
            files: input.files,
          });
          if (saved) {
            captureServer("google_sheets_picked", {
              distinctId: member.userId,
              properties: { workspace_id: input.workspaceId, file_count: input.files.length },
              groups: { workspace: input.workspaceId },
            });
          }
          return { saved };
        }),
      ),
    ),

  /**
   * Forget the connection. Local delete only — no Google-side token revocation,
   * matching the Slack and CRM disconnects. Revoking at Google would also
   * invalidate the user's per-file authorisations, so reconnecting would mean
   * re-picking every spreadsheet — a surprising cost for what reads as "unlink
   * this workspace".
   */
  disconnect: protectedProcedure
    .input(z.object({ workspaceId: z.string().min(1) }))
    .mutation(({ ctx, input }) =>
      runEffect(
        ctx.runtime,
        Effect.gen(function* () {
          const membership = yield* MembershipService;
          yield* membership.requireMember(input.workspaceId);
          const connection = yield* GoogleConnectionService;
          const removed = yield* connection.disconnect(input.workspaceId);
          return { removed };
        }),
      ),
    ),
});
