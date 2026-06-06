/**
 * Credential storage + read functions that run in the DEFAULT Convex runtime
 * (queries/mutations) — split out from convex/credentials.ts because that file
 * is `"use node"` (it needs `node:crypto`), and a `"use node"` module may only
 * export actions. The node ACTIONS in convex/credentials.ts call the internal
 * functions here via `ctx.runMutation` / `ctx.runQuery`.
 *
 * Two boundaries are enforced here:
 *   - `listCredentials` (public query) NEVER returns `secretsEnc` or plaintext —
 *     only the metadata the UI needs (which connectors are connected). This is
 *     the "listing queries never return plaintext" acceptance criterion.
 *   - `storeCredential` / `getCredentialEnc` (internal) move ONLY ciphertext, and
 *     re-check workspace membership themselves so the authz rule lives with the
 *     data access (mirrors workspaces.ts `insertMember`).
 */

import {
  CredentialOwnershipError,
  CredentialOwnershipService,
  type CredentialScope,
} from "@gtmgrid/cloud";
import { ConvexError, v } from "convex/values";
import { Cause, Effect, Exit, Option } from "effect";
import { getCurrentUserId, requireMember } from "./model/auth.js";
import { credentialScope } from "./schema.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import {
  internalMutation,
  internalQuery,
  query,
} from "./_generated/server.js";

/**
 * The owner binding a row of `scope` must be stored/looked-up under. Runs the
 * pure {@link CredentialOwnershipService} (`@gtmgrid/cloud`) and translates its
 * `Option<string>` into the nullable `ownerUserId` column shape. `personal` rows
 * bind to `currentUserId`; `workspace` rows are shared (`null`).
 */
function ownerForScope(
  scope: CredentialScope,
  currentUserId: string,
): string | null {
  const owner = Effect.runSync(
    Effect.gen(function* () {
      const svc = yield* CredentialOwnershipService;
      return svc.ownerFor(scope, currentUserId);
    }).pipe(Effect.provide(CredentialOwnershipService.Default)),
  );
  return Option.getOrNull(owner);
}

/**
 * Assert the current user may read/rotate an existing credential row, running
 * the pure {@link CredentialOwnershipService} and translating a typed
 * {@link CredentialOwnershipError} into a `ConvexError`. A `personal` row owned
 * by another member (or a legacy personal row with no owner) is rejected;
 * `workspace` rows are always accessible (membership is enforced upstream).
 */
async function assertCanAccess(
  row: Doc<"credentials">,
  currentUserId: string,
): Promise<void> {
  const exit = await Effect.runPromiseExit(
    Effect.gen(function* () {
      const svc = yield* CredentialOwnershipService;
      return yield* svc.assertCanAccess({
        scope: row.scope,
        extensionId: row.extensionId,
        currentUserId,
        storedOwnerUserId: Option.fromNullable(row.ownerUserId),
      });
    }).pipe(Effect.provide(CredentialOwnershipService.Default)),
  );
  if (Exit.isSuccess(exit)) return;

  const failure = Cause.failureOption(exit.cause);
  if (Option.isSome(failure) && failure.value instanceof CredentialOwnershipError) {
    throw new ConvexError({
      code: failure.value._tag,
      message: failure.value.message,
    });
  }
  throw new Error(Cause.pretty(exit.cause));
}

/**
 * The authenticated user id for a credential write/read, or a `ConvexError` when
 * signed out. Personal-scope ownership is keyed off this id, so it must be known
 * before any personal row is stored or read.
 */
async function requireCurrentUserId(
  ctx: Parameters<typeof getCurrentUserId>[0],
): Promise<Id<"users">> {
  const userId = await getCurrentUserId(ctx);
  if (userId === null) {
    throw new ConvexError({
      code: "UnauthenticatedError",
      message: "Sign in to access credentials.",
    });
  }
  return userId;
}

/**
 * List a workspace's saved credentials as METADATA ONLY. Returns which
 * connectors are connected (id, scope, name, when) so the UI can render the
 * panel — but NEVER the ciphertext (`secretsEnc`) and never plaintext. Plaintext
 * is reachable only via the trusted decrypt-for-run action. Members-only.
 */
export const listCredentials = query({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, { workspaceId }) => {
    await requireMember(ctx, workspaceId);
    const currentUserId = await requireCurrentUserId(ctx);

    const rows = await ctx.db
      .query("credentials")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .collect();

    // Project to metadata ONLY — secretsEnc is deliberately omitted so it can
    // never cross the query boundary to a client. Personal rows are scoped to
    // their owner: a member sees the shared workspace rows plus only their OWN
    // personal keys, never another member's.
    return rows
      .filter(
        (c) => c.scope === "workspace" || c.ownerUserId === currentUserId,
      )
      .map((c) => ({
        _id: c._id,
        extensionId: c.extensionId,
        scope: c.scope,
        name: c.name,
        createdAt: c.createdAt,
      }));
  },
});

/**
 * Insert or rotate an ALREADY-ENCRYPTED credential. Internal: only the
 * `saveCredential` action (which performs the envelope encryption) calls this.
 * Re-checks membership so the authz rule lives with the write. Upserts on
 * (workspaceId, extensionId, scope) so re-saving a connector's key rotates it in
 * place rather than accumulating rows.
 */
export const storeCredential = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    extensionId: v.string(),
    scope: credentialScope,
    name: v.string(),
    /** Envelope-encrypted ciphertext of the secret map. NEVER plaintext. */
    secretsEnc: v.string(),
  },
  handler: async (ctx, args) => {
    await requireMember(ctx, args.workspaceId);
    const currentUserId = await requireCurrentUserId(ctx);

    // `personal` rows bind to the caller; `workspace` rows are shared (null).
    const ownerUserId = ownerForScope(args.scope, currentUserId);

    // Upsert keyed on (workspace, extension, scope, owner): two members saving a
    // personal key for the same connector resolve to distinct owner bindings, so
    // they no longer collide on a single row. Workspace rows key on a null owner.
    const existing = await ctx.db
      .query("credentials")
      .withIndex("by_workspace_extension_owner", (q) =>
        q
          .eq("workspaceId", args.workspaceId)
          .eq("extensionId", args.extensionId)
          .eq("scope", args.scope)
          .eq("ownerUserId", ownerUserId),
      )
      .unique();

    if (existing !== null) {
      // Defense in depth: a personal row reachable on this key is the caller's
      // own, but assert it before rotating so the rule lives with the write.
      await assertCanAccess(existing, currentUserId);
      await ctx.db.patch(existing._id, {
        name: args.name,
        secretsEnc: args.secretsEnc,
      });
      return existing._id;
    }
    return await ctx.db.insert("credentials", {
      workspaceId: args.workspaceId,
      extensionId: args.extensionId,
      scope: args.scope,
      ownerUserId,
      name: args.name,
      secretsEnc: args.secretsEnc,
      createdAt: Date.now(),
    });
  },
});

/**
 * Fetch a credential's ciphertext for the trusted decrypt-for-run path.
 * Internal: only the `getCredentialForRun` action calls this, then decrypts.
 * Re-checks membership (so a non-member can never obtain even the ciphertext)
 * and returns `null` when no matching credential exists. Plaintext is NEVER
 * produced here — decryption happens in the node action after this gate.
 */
export const getCredentialEnc = internalQuery({
  args: {
    workspaceId: v.id("workspaces"),
    extensionId: v.string(),
    scope: credentialScope,
  },
  handler: async (ctx, { workspaceId, extensionId, scope }) => {
    // Authz: only a member of this workspace may reach the ciphertext. A
    // non-member throws here, before any decrypt is attempted.
    await requireMember(ctx, workspaceId);
    const currentUserId = await requireCurrentUserId(ctx);

    // `personal` rows resolve to the caller's owner binding (so a member only
    // reaches their OWN personal key); `workspace` rows key on a null owner.
    const ownerUserId = ownerForScope(scope, currentUserId);

    const cred = await ctx.db
      .query("credentials")
      .withIndex("by_workspace_extension_owner", (q) =>
        q
          .eq("workspaceId", workspaceId)
          .eq("extensionId", extensionId)
          .eq("scope", scope)
          .eq("ownerUserId", ownerUserId),
      )
      .unique();
    if (cred === null) return null;

    // Defense in depth: reject a personal row that isn't the caller's before any
    // ciphertext crosses to the decrypt-for-run action.
    await assertCanAccess(cred, currentUserId);
    return { secretsEnc: cred.secretsEnc };
  },
});

/**
 * Fetch a WORKSPACE-scoped credential's ciphertext for the headless webhook
 * worker. Internal: only the `getCredentialForWorker` action (convex/
 * webhooks.ts) calls this, then decrypts in the Node runtime.
 *
 * Unlike {@link getCredentialEnc}, this performs NO `requireMember` /
 * `requireCurrentUserId` — the worker is an unauthenticated headless caller
 * already gated by the WEBHOOK_WORKER_SECRET at the HTTP boundary. It is
 * therefore deliberately restricted to SHARED `workspace`-scope rows
 * (`ownerUserId === null`): a headless worker has no member identity and must
 * never reach a member's `personal` key. Returns `null` when no shared
 * credential exists for the connector.
 */
export const getCredentialEncForWorker = internalQuery({
  args: {
    workspaceId: v.id("workspaces"),
    extensionId: v.string(),
  },
  handler: async (ctx, { workspaceId, extensionId }) => {
    const cred = await ctx.db
      .query("credentials")
      .withIndex("by_workspace_extension_owner", (q) =>
        q
          .eq("workspaceId", workspaceId)
          .eq("extensionId", extensionId)
          .eq("scope", "workspace")
          .eq("ownerUserId", null),
      )
      .unique();
    if (cred === null) return null;
    return { secretsEnc: cred.secretsEnc };
  },
});
