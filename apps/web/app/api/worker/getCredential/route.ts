/**
 * Worker endpoint: decrypt a SHARED (workspace-scope) connector credential for
 * the worker, or `null` when none exists. Replaces `convex/http.ts`
 * `/webhook/getCredential`. Secret-gated bearer; `node:crypto` decrypt.
 */

import { WebhookService } from "@gtmgrid/services";
import { Effect } from "effect";
import { runWorker } from "../_lib";

export const runtime = "nodejs";

interface GetCredentialBody {
  workspaceId: string;
  extensionId: string;
}

export function POST(req: Request): Promise<Response> {
  return runWorker(req, (body: GetCredentialBody) =>
    Effect.gen(function* () {
      const svc = yield* WebhookService;
      return yield* svc.getCredential({
        workspaceId: body.workspaceId,
        extensionId: body.extensionId,
      });
    }),
  );
}
