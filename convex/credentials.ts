/**
 * Credential Convex mutation (T4).
 *
 * - `saveCredential` (mutation): upsert a workspace/personal connector
 *   credential. Members-only.
 *
 * SEAM FOR T7 (workspace-encrypted credentials): this mutation accepts the
 * already-encrypted `secretsEnc` ciphertext and never sees plaintext — the
 * envelope encryption (workspace-scoped key wrapped by a backend master secret)
 * is performed in the trusted encrypt path T7 adds (a Convex action that calls
 * this mutation, or an inline encrypt step). Storing only ciphertext here keeps
 * plaintext secrets off every client and out of the DB, per the plan's
 * shared-credentials section. T4 establishes the storage + authz shape.
 *
 * Upserts on (workspaceId, extensionId, scope) so re-saving a connector's key
 * rotates it in place rather than accumulating rows.
 */

import { v } from "convex/values";
import { requireMember } from "./model/auth.js";
import { credentialScope } from "./schema.js";
import { mutation } from "./_generated/server.js";

/**
 * Save (insert or rotate) an encrypted credential. The caller supplies
 * ciphertext (`secretsEnc`); plaintext never crosses this boundary.
 * Members-only.
 */
export const saveCredential = mutation({
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

    // Upsert on (workspaceId, extensionId, scope). The by_workspace_extension
    // index narrows to the workspace+extension; we then match the scope so a
    // workspace-shared key and a personal key for the same connector coexist.
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
