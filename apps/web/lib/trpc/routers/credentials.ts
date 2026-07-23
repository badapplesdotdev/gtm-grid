/**
 * The `credentials` tRPC router — the Postgres-tier port of the Convex
 * credential functions (convex/credentials.ts + convex/credentialsData.ts), with
 * the `"use node"` action/mutation split collapsed into single procedures.
 *
 * Every procedure is a `cloudWorkspaceProcedure`, so membership is asserted by the
 * middleware BEFORE the body runs; the body then resolves {@link CredentialService}
 * from the request runtime and runs the Effect via {@link runEffect}. The
 * security invariants (the AC) are enforced inside `CredentialService`:
 *
 *   - `save`   — encrypt then upsert; plaintext never reaches the DB.
 *   - `getForRun` — member-gated decrypt; the ONLY procedure that yields plaintext.
 *   - `list`   — METADATA ONLY; never returns `secretsEnc`; personal rows filtered
 *     to the caller.
 *
 * `CredentialOwnershipError` is mapped to `FORBIDDEN` by the `runEffect` error
 * translator (apps/web/lib/trpc/trpc.ts).
 */

import { CredentialService } from "@gtmgrid/services";
import { Effect, Option } from "effect";
import { z } from "zod";
import { router, runEffect, cloudWorkspaceProcedure } from "../trpc";

/** Connector scope — mirrors the `credential_scope` pgEnum. */
const credentialScope = z.enum(["workspace", "personal"]);

/** A non-empty connector id (e.g. `"ai:openai"`). */
const extensionId = z.string().min(1);

/** Shared input for the get-for-run / save lookups (workspaceId comes from the
 * `cloudWorkspaceProcedure` base input). */
const connectorInput = z.object({
  extensionId,
  scope: credentialScope,
});

/** The credentials API surface. */
export const credentialsRouter = router({
  /**
   * List a workspace's saved credentials as METADATA ONLY — which connectors are
   * connected, never the ciphertext. A member sees the shared workspace rows plus
   * only their OWN personal keys.
   */
  list: cloudWorkspaceProcedure.query(({ ctx, input }) =>
    runEffect(
      ctx.runtime,
      Effect.gen(function* () {
        const svc = yield* CredentialService;
        return yield* svc.listCredentials(input.workspaceId);
      }),
    ),
  ),

  /**
   * Save (insert or rotate) a connector credential. Accepts the PLAINTEXT secret
   * map; the service envelope-encrypts it and persists only the ciphertext.
   * Upserts on (workspace, extension, scope, owner). Returns the row id.
   */
  save: cloudWorkspaceProcedure
    .input(
      connectorInput.extend({
        name: z.string().min(1),
        /** PLAINTEXT secret map. Encrypted before storage; never persisted raw. */
        secrets: z.record(z.string(), z.string()),
      }),
    )
    .mutation(({ ctx, input }) =>
      runEffect(
        ctx.runtime,
        Effect.gen(function* () {
          const svc = yield* CredentialService;
          return yield* svc.saveCredential({
            workspaceId: input.workspaceId,
            extensionId: input.extensionId,
            scope: input.scope,
            name: input.name,
            secrets: input.secrets,
          });
        }),
      ),
    ),

  /**
   * Delete a saved credential. `save` can only ever REPLACE a key, so this is
   * the only way to hand a workspace back without its keys — the case that
   * matters when a workspace was seeded with someone else's keys and its members
   * now want to supply their own.
   *
   * Shared (`workspace`) rows are OWNER/ADMIN only, matching the Slack/CRM
   * disconnect: deleting one breaks every other member's columns and cannot be
   * undone without the original secret. `personal` rows always resolve to the
   * caller's own, so anyone can delete theirs.
   *
   * Returns `{ removed: false }` when nothing matched — idempotent, so a retry
   * or a double-click is harmless.
   */
  remove: cloudWorkspaceProcedure
    .input(connectorInput)
    .mutation(({ ctx, input }) =>
      runEffect(
        ctx.runtime,
        Effect.gen(function* () {
          const svc = yield* CredentialService;
          const removed = yield* svc.removeCredential({
            workspaceId: input.workspaceId,
            extensionId: input.extensionId,
            scope: input.scope,
          });
          return { removed };
        }),
      ),
    ),

  /**
   * Decrypt-for-run: return the PLAINTEXT secret map for a connector to an
   * authorized member. The ONLY procedure that yields plaintext. Returns `null`
   * when no matching credential exists.
   */
  getForRun: cloudWorkspaceProcedure
    .input(connectorInput)
    .query(({ ctx, input }) =>
      runEffect(
        ctx.runtime,
        Effect.gen(function* () {
          const svc = yield* CredentialService;
          const secrets = yield* svc.getCredentialForRun({
            workspaceId: input.workspaceId,
            extensionId: input.extensionId,
            scope: input.scope,
          });
          return Option.getOrNull(secrets);
        }),
      ),
    ),
});
