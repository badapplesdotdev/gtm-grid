/**
 * Worker endpoint: a workspace's INSTALLED connector-extension manifests, so the
 * cloud worker can register those connectors before running a column. Without
 * this the worker's engine has only the built-in connectors, and a column that
 * calls a manifest connector (`sdk["leadmagic"]["emailfinder"](…)`) throws
 * "cannot read property …" because `sdk["leadmagic"]` is undefined.
 *
 * DUAL-AUTH (worker-secret OR member-session):
 *   - Worker-secret path (trusted headless, <code>userId=null</code>): reads the
 *     {@link ExtensionRepo} directly, skipping the membership assertion — the
 *     shared secret is the trust boundary, exactly like the sibling
 *     `getCredential` / `getTable` worker routes.
 *   - Member-session path: routes through {@link ExtensionService.listExtensions}
 *     which enforces workspace membership via {@link MembershipService.requireMember}.
 *     This closes the IDOR where a member could pass another workspace's id and
 *     list their extensions.
 */

import { MembershipService, UnauthenticatedError } from "@gtmgrid/cloud";
import { ExtensionRepo, ExtensionService } from "@gtmgrid/services";
import { Effect } from "effect";
import { runWorkerSecretOrMember } from "../_lib";
import { GetExtensionsSchema } from "../_schemas";

export const runtime = "nodejs";

export function POST(req: Request): Promise<Response> {
  return runWorkerSecretOrMember(req, GetExtensionsSchema, (body) =>
    Effect.gen(function* () {
      const membership = yield* MembershipService;

      // Try to get the authenticated user id. On the worker-secret path
      // (userId: null), requireUserId fails with UnauthenticatedError — the
      // shared secret is the trust boundary, so we fall through to the
      // direct-ExtensionRepo path (no membership check).
      const maybeUserId = yield* membership.requireUserId.pipe(
        Effect.catchTag("UnauthenticatedError", () => Effect.succeed(null)),
      );

      if (maybeUserId === null) {
        // Path 1 — headless worker (shared-secret auth, no member identity).
        const repo = yield* ExtensionRepo;
        const extensions = yield* repo.listByWorkspace(body.workspaceId);
        return extensions.map((e) => e.manifest);
      }

      // Path 2 — authenticated member. ExtensionService.listExtensions calls
      // MembershipService.requireMember which rejects non-members with 403.
      const svc = yield* ExtensionService;
      const extensions = yield* svc.listExtensions(body.workspaceId);
      return extensions.map((e) => e.manifest);
    }),
  );
}