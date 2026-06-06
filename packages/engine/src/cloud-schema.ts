/**
 * Pure mapping/validation helpers between the engine's local domain model
 * (packages/engine/src/types.ts) and the cloud Convex schema (convex/schema.ts).
 *
 * The Convex schema mirrors the engine model but with two deliberate
 * differences this service encodes and validates:
 *
 *   1. CellStatus is identical on both sides (empty|pending|running|done|error),
 *      so `cellStatusForCloud` is a validating pass-through. It exists so the
 *      ConvexGridStore (T5) can fail loudly with a typed error if a future
 *      engine status drifts from the cloud literal union, instead of writing an
 *      invalid value that Convex would reject at runtime.
 *
 *   2. CredentialScope differs: the engine has `local | personal | team`, but
 *      cloud (shared, server-side encrypted) credentials only support
 *      `workspace | personal`. The engine's `team` scope maps to cloud
 *      `workspace` (shared team key); `personal` maps through; `local` has no
 *      cloud equivalent and fails with a typed error (local keys never leave the
 *      machine — see the plan's shared-credentials section).
 *
 * This is the canonical Effect-TS service shape (see docs/effect-conventions.md):
 * typed errors via Data.TaggedError, an Effect.Service with a `.Default` Layer,
 * methods returning Effect.Effect. It is pure (no Convex import) so it stays in
 * the root `tsc -b` graph and runs under the engine's existing Vitest project.
 */

import { Data, Effect } from "effect";
import type { CellStatus, CredentialScope } from "./types.js";

/** The status literals the cloud `cells.status` column accepts (convex/schema.ts). */
export type CloudCellStatus = "empty" | "pending" | "running" | "done" | "error";

/** The scope literals cloud `credentials.scope` accepts (convex/schema.ts). */
export type CloudCredentialScope = "workspace" | "personal";

const CLOUD_CELL_STATUSES: readonly CloudCellStatus[] = [
  "empty",
  "pending",
  "running",
  "done",
  "error",
];

/** Type guard: narrows an arbitrary value to a {@link CloudCellStatus} (no casts). */
const isCloudCellStatus = (value: unknown): value is CloudCellStatus =>
  CLOUD_CELL_STATUSES.some((status) => status === value);

/** Raised when an engine cell status has no matching cloud literal. */
export class UnknownCellStatusError extends Data.TaggedError(
  "UnknownCellStatusError",
)<{
  readonly message: string;
  readonly received: unknown;
}> {}

/**
 * Raised when an engine credential scope cannot be represented in the cloud.
 * Today this is only the engine's machine-local `local` scope, which must never
 * be synced to a shared workspace.
 */
export class UnmappableCredentialScopeError extends Data.TaggedError(
  "UnmappableCredentialScopeError",
)<{
  readonly message: string;
  readonly received: CredentialScope;
}> {}

/**
 * Maps/validates engine domain values onto the cloud Convex schema's allowed
 * literals, failing with typed errors when a value cannot be represented.
 */
export class CloudSchemaMapping extends Effect.Service<CloudSchemaMapping>()(
  "CloudSchemaMapping",
  {
    sync: () => ({
      /**
       * Validate an engine {@link CellStatus} for the cloud `cells.status`
       * column. A pass-through today, but typed so status drift is caught.
       */
      cellStatusForCloud: (
        status: CellStatus | string,
      ): Effect.Effect<CloudCellStatus, UnknownCellStatusError> =>
        isCloudCellStatus(status)
          ? Effect.succeed(status)
          : Effect.fail(
              new UnknownCellStatusError({
                message: `Unknown cell status ${JSON.stringify(status)}; not a valid cloud cells.status literal`,
                received: status,
              }),
            ),

      /**
       * Map an engine {@link CredentialScope} to a cloud credential scope.
       * `team` -> `workspace` (shared team key), `personal` -> `personal`,
       * `local` -> typed failure (machine-local keys never go to the cloud).
       */
      credentialScopeForCloud: (
        scope: CredentialScope,
      ): Effect.Effect<
        CloudCredentialScope,
        UnmappableCredentialScopeError
      > => {
        switch (scope) {
          case "team":
            return Effect.succeed("workspace");
          case "personal":
            return Effect.succeed("personal");
          case "local":
            return Effect.fail(
              new UnmappableCredentialScopeError({
                message:
                  "Local credentials are machine-local and cannot be synced to a shared cloud workspace",
                received: scope,
              }),
            );
        }
      },
    }),
  },
) {}
