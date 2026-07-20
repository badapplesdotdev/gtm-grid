/**
 * Worker endpoint: decrypt a SHARED (workspace-scope) connector credential for
 * the worker, or `null` when none exists. Replaces `convex/http.ts`
 * `/webhook/getCredential`. Secret-gated bearer; `node:crypto` decrypt.
 *
 * For an OAUTH slot the stored access token may be stale, so the credential is
 * REFRESHED here before the plaintext leaves the box. This is the only place a
 * credential is minted for a run, which is what lets the engine hold no
 * `client_secret` and never rotate — and gives Slack's single-use refresh
 * tokens exactly one serialized writer.
 *
 * The refresh lives in the ROUTE rather than inside `WebhookService.getCredential`
 * deliberately: this endpoint is that method's ONLY caller, and making
 * `WebhookService` depend on `OAuthCredentialService` broke every test that
 * hand-composes its Layer (and would quietly require every future one to know
 * about OAuth). Same behaviour, far smaller blast radius.
 */

import { OAuthCredentialService, WebhookService } from "@gtmgrid/services";
import { Effect } from "effect";
import { runWorkerSecretOrMember } from "../_lib";
import { GetCredentialSchema } from "../_schemas";

export const runtime = "nodejs";
export function POST(req: Request): Promise<Response> {
  return runWorkerSecretOrMember(req, GetCredentialSchema, (body) =>
    Effect.gen(function* () {
      const svc = yield* WebhookService;
      const stored = yield* svc.getCredential({
        workspaceId: body.workspaceId,
        extensionId: body.extensionId,
        accountId: body.accountId,
      });
      if (stored === null) return null;

      const oauth = yield* OAuthCredentialService;
      // A non-OAuth slot passes straight through. A refresh FAILURE must not
      // fail the read: the caller's own 401 handling is the backstop, whereas
      // returning null here would read as "not connected" and surface as a
      // baffling "connect Slack" error on a connection that is fine.
      // `stored.accountId` (the RESOLVED account), not `body.accountId`: when
      // the caller named none and the workspace has exactly one, the refresh
      // must still write back to THAT row. Passing the request's undefined
      // through would re-read and persist the `""` row instead — burning a
      // single-use Slack refresh token and storing the result where nothing
      // reads it.
      const secrets = yield* oauth
        .freshSecrets(
          body.workspaceId,
          body.extensionId,
          stored.secrets,
          stored.accountId,
        )
        .pipe(
          Effect.catchAll((e) =>
            Effect.logWarning("oauth refresh failed for a run credential; using the stored token").pipe(
              Effect.annotateLogs({ extensionId: body.extensionId, error: e._tag }),
              Effect.as(stored.secrets),
            ),
          ),
        );
      return { secrets };
    }),
  );
}
