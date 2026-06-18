/**
 * Worker endpoint: return a workspace's installed extension MANIFESTS so the
 * headless inngest enrichment worker can build an extension-aware engine
 * registry (the same connectors a local project loads) before recomputing a
 * function column. Without these the worker only has the built-ins and any
 * column wired to an uploaded connector (leadmagic/trigify/…) hard-fails.
 *
 * Secret-gated bearer on the headless path (member-attributed on the desktop
 * path), exactly like `/api/worker/getCredential`.
 */

import { WebhookService } from "@gtmgrid/services";
import { Effect } from "effect";
import { runWorkerSecretOrMember } from "../_lib";
import { ListExtensionsSchema } from "../_schemas";

export const runtime = "nodejs";

export function POST(req: Request): Promise<Response> {
  return runWorkerSecretOrMember(req, ListExtensionsSchema, (body) =>
    Effect.gen(function* () {
      const svc = yield* WebhookService;
      const manifests = yield* svc.listExtensionManifests({
        workspaceId: body.workspaceId,
      });
      return { manifests };
    }),
  );
}
