/**
 * Worker endpoint: a workspace's INSTALLED connector-extension manifests, so the
 * cloud worker can register those connectors before running a column. Without
 * this the worker's engine has only the built-in connectors, and a column that
 * calls a manifest connector (`sdk["leadmagic"]["emailfinder"](…)`) throws
 * "cannot read property …" because `sdk["leadmagic"]` is undefined.
 *
 * Member-FREE (secret-gated bearer): reads the {@link ExtensionRepo} directly,
 * skipping the membership assertion the member-facing `ExtensionService` adds —
 * the worker carries no member identity (the shared secret is the trust boundary,
 * exactly like the sibling `getCredential` / `getTable` worker routes).
 */

import { ExtensionRepo } from "@gtmgrid/services";
import { Effect } from "effect";
import { runWorkerSecretOrMember } from "../_lib";
import { GetExtensionsSchema } from "../_schemas";

export const runtime = "nodejs";

export function POST(req: Request): Promise<Response> {
  return runWorkerSecretOrMember(req, GetExtensionsSchema, (body) =>
    Effect.gen(function* () {
      const repo = yield* ExtensionRepo;
      const extensions = yield* repo.listByWorkspace(body.workspaceId);
      // Return just the manifest JSONs — the engine builds connectors from them.
      return extensions.map((e) => e.manifest);
    }),
  );
}
