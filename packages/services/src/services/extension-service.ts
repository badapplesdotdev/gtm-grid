/**
 * `ExtensionService` — the extension domain service (member-gated).
 *
 * Ports `convex/extensions.ts`:
 *   - {@link ExtensionService.listExtensions} — a workspace's installed
 *     connector extensions. Members-only.
 *   - {@link ExtensionService.saveExtension} — UPSERT a manifest by
 *     (workspaceId, extensionId): install a new one or update in place. The
 *     Convex action/mutation split collapses into this single procedure.
 *
 * Authz uses the same `MembershipService.requireMember` port as the worked
 * example; both methods assert membership before any read/write.
 */

import {
  type InsufficientRoleError,
  type MemberRepoError,
  MembershipService,
  type NotAMemberError,
  type UnauthenticatedError,
} from "@gtmgrid/cloud";
import { Effect } from "effect";
import {
  type Extension,
  ExtensionRepo,
  type ExtensionRepoError,
} from "../repositories/extension-repo.js";

/** The authz + repo error channel both extension methods share. */
type ExtensionAuthzError =
  | UnauthenticatedError
  | NotAMemberError
  | InsufficientRoleError
  | MemberRepoError
  | ExtensionRepoError;

/**
 * Extension domain service. Composes {@link ExtensionRepo} +
 * {@link MembershipService} into membership-guarded list + upsert.
 */
export class ExtensionService extends Effect.Service<ExtensionService>()(
  "ExtensionService",
  {
    effect: Effect.gen(function* () {
      const repo = yield* ExtensionRepo;
      const membership = yield* MembershipService;

      /** A workspace's extensions. Members-only. */
      const listExtensions = (
        workspaceId: string,
      ): Effect.Effect<readonly Extension[], ExtensionAuthzError> =>
        Effect.gen(function* () {
          yield* membership.requireMember(workspaceId);
          return yield* repo.listByWorkspace(workspaceId);
        });

      /**
       * Install or update an extension by (workspaceId, extensionId). Re-saving
       * the same extension PATCHES its manifest rather than duplicating it.
       * Members-only. Returns the extension's id.
       */
      const saveExtension = (args: {
        readonly workspaceId: string;
        readonly extensionId: string;
        readonly name: string;
        readonly category?: string | null;
        readonly manifest: unknown;
      }): Effect.Effect<string, ExtensionAuthzError> =>
        Effect.gen(function* () {
          yield* membership.requireMember(args.workspaceId);

          const existing = yield* repo.findByWorkspaceExtension(
            args.workspaceId,
            args.extensionId,
          );
          const fields = {
            name: args.name,
            category: args.category ?? null,
            manifest: args.manifest,
          };
          if (existing._tag === "Some") {
            yield* repo.patch(existing.value.id, fields);
            return existing.value.id;
          }
          return yield* repo.insert({
            workspaceId: args.workspaceId,
            extensionId: args.extensionId,
            ...fields,
          });
        });

      return { listExtensions, saveExtension } as const;
    }),
    dependencies: [],
  },
) {}
