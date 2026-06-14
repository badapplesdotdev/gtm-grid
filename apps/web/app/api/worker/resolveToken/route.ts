/**
 * Worker endpoint: resolve a webhook token to its (enabled) config, or `null`.
 * Replaces `convex/http.ts` `/webhook/resolveToken`. Secret-gated bearer.
 */

import { WebhookService } from "@gtmgrid/services";
import { Effect } from "effect";
import { runWorker } from "../_lib";
import { ResolveTokenSchema } from "../_schemas";

export const runtime = "nodejs";

export function POST(req: Request): Promise<Response> {
  return runWorker(req, ResolveTokenSchema, (body) =>
    Effect.gen(function* () {
      const svc = yield* WebhookService;
      return yield* svc.resolveToken(body.token);
    }),
  );
}
