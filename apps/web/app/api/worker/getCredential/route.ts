/**
 * Worker endpoint: decrypt a SHARED (workspace-scope) connector credential for
 * the worker, or `null` when none exists. Replaces `convex/http.ts`
 * `/webhook/getCredential`. Secret-gated bearer; `node:crypto` decrypt.
 */

import { WebhookService } from "@gtmgrid/services";
import { Effect } from "effect";
import { runWorkerSecretOrMember } from "../_lib";
import { GetCredentialSchema } from "../_schemas";

export const runtime = "nodejs";
export function POST(req: Request): Promise<Response> {
  return runWorkerSecretOrMember(req, GetCredentialSchema, (body) =>
    Effect.gen(function* () {
      const svc = yield* WebhookService;
      return yield* svc.getCredential({
        workspaceId: body.workspaceId,
        extensionId: body.extensionId,
      });
    }),
  );
}
