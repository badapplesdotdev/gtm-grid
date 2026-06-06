"use node";
/**
 * Workspace-encrypted credential ACTIONS (T7).
 *
 * Cloud connector credentials are encrypted at rest in Convex via ENVELOPE
 * ENCRYPTION: a fresh per-credential data key encrypts the secret map
 * (AES-256-GCM), and that data key is wrapped by a backend master secret read
 * from `CREDENTIALS_MASTER_KEY` (see convex/model/crypto.ts). The wrap is bound
 * to the workspace id, so a ciphertext is cryptographically workspace-scoped.
 *
 * This file is `"use node"` because the envelope crypto uses `node:crypto`,
 * which only runs in Convex's Node action runtime. A `"use node"` module may
 * export ONLY actions, so the queries / internal mutations live in
 * convex/credentialsData.ts and are invoked here via `ctx.runQuery` /
 * `ctx.runMutation`.
 *
 *   - `saveCredential` (action): the T4 save path, now ENCRYPTING before storing.
 *     Accepts the PLAINTEXT secret map from the (authorized) member, envelope-
 *     encrypts it, and persists only the ciphertext. Plaintext never reaches the
 *     DB and never crosses to other members' clients.
 *   - `getCredentialForRun` (action): the decrypt-for-run path. Returns the
 *     PLAINTEXT secret map ONLY to a member of the workspace, for a run. Listing
 *     (convex/credentialsData.ts `listCredentials`) never returns plaintext.
 *
 * The local machine-key model (packages/engine/src/crypto.ts) is untouched —
 * cloud needs a server-held master secret, not a per-machine key.
 */

import { v } from "convex/values";
import { decryptSecretsForRun, encryptSecrets } from "./model/crypto.js";
import { credentialScope } from "./schema.js";
import { internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { action } from "./_generated/server.js";

/**
 * Save (insert or rotate) a workspace/personal connector credential, encrypting
 * the secret map at rest. The caller supplies PLAINTEXT `secrets`; this action
 * envelope-encrypts them and hands only the ciphertext to the internal
 * `storeCredential` mutation (which re-checks workspace membership). Plaintext
 * is never persisted. Members-only (enforced inside `storeCredential`).
 *
 * Upserts on (workspaceId, extensionId, scope) so re-saving a connector's key
 * rotates it in place rather than accumulating rows.
 */
export const saveCredential = action({
  args: {
    workspaceId: v.id("workspaces"),
    extensionId: v.string(),
    scope: credentialScope,
    name: v.string(),
    /** PLAINTEXT secret map (e.g. `{ apiKey: "..." }`). Encrypted before storage. */
    secrets: v.record(v.string(), v.string()),
  },
  handler: async (ctx, args): Promise<Id<"credentials">> => {
    // Envelope-encrypt the plaintext for this workspace before it touches the DB.
    const secretsEnc = await encryptSecrets(args.workspaceId, args.secrets);
    return await ctx.runMutation(internal.credentialsData.storeCredential, {
      workspaceId: args.workspaceId,
      extensionId: args.extensionId,
      scope: args.scope,
      name: args.name,
      secretsEnc,
    });
  },
});

/**
 * Decrypt-for-run: return the PLAINTEXT secret map for a connector to an
 * AUTHORIZED member, so the local engine can run that connector. Authz is
 * enforced by the internal `getCredentialEnc` query (members-only) BEFORE this
 * action ever sees the ciphertext; decryption then happens here in the Node
 * runtime. Returns `null` when no matching credential exists.
 *
 * This is the ONLY path that yields plaintext. Listing queries
 * (`listCredentials`) never do.
 */
export const getCredentialForRun = action({
  args: {
    workspaceId: v.id("workspaces"),
    extensionId: v.string(),
    scope: credentialScope,
  },
  handler: async (
    ctx,
    { workspaceId, extensionId, scope },
  ): Promise<{ secrets: Record<string, string> } | null> => {
    // Authz + fetch ciphertext (non-member throws inside the query).
    const row = await ctx.runQuery(internal.credentialsData.getCredentialEnc, {
      workspaceId,
      extensionId,
      scope,
    });
    if (row === null) return null;

    const secrets = await decryptSecretsForRun(workspaceId, row.secretsEnc);
    return { secrets };
  },
});
