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

import { v } from "convex/values";
import { requireMember } from "./model/auth.js";
import { credentialScope } from "./schema.js";
import {
  internalMutation,
  internalQuery,
  query,
} from "./_generated/server.js";

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

    const rows = await ctx.db
      .query("credentials")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .collect();

    // Project to metadata ONLY — secretsEnc is deliberately omitted so it can
    // never cross the query boundary to a client.
    return rows.map((c) => ({
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

    const matches = await ctx.db
      .query("credentials")
      .withIndex("by_workspace_extension", (q) =>
        q
          .eq("workspaceId", args.workspaceId)
          .eq("extensionId", args.extensionId),
      )
      .collect();
    const existing = matches.find((c) => c.scope === args.scope) ?? null;

    if (existing !== null) {
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

    const matches = await ctx.db
      .query("credentials")
      .withIndex("by_workspace_extension", (q) =>
        q.eq("workspaceId", workspaceId).eq("extensionId", extensionId),
      )
      .collect();
    const cred = matches.find((c) => c.scope === scope) ?? null;
    if (cred === null) return null;
    return { secretsEnc: cred.secretsEnc };
  },
});
