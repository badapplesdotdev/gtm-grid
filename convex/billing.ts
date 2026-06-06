/**
 * Autumn billing actions (T6).
 *
 * Autumn is the single source of truth for entitlement; the only gate is
 * `seats`. There are NO connector/table caps anywhere.
 *
 * `checkout` is the standalone upgrade entry point: an owner/admin asks to
 * upgrade their workspace, and Autumn `attach` returns a hosted billing URL the
 * UI opens (the upgrade modal / "Upgrade" button). It complements the seat gate
 * baked into `inviteMember` (convex/workspaces.ts), which returns a checkout URL
 * inline when an invite exceeds the seat limit.
 *
 * Runs as an ACTION because it makes an outbound HTTP call to Autumn (mutations
 * cannot). Authz (owner/admin only — billing is a privileged action) is enforced
 * via the `assertBillingAdmin` internal query before the Autumn call, since
 * actions have no direct `ctx.db`. The workspace id is the Autumn customer id.
 */

import { v } from "convex/values";
import { requireRole } from "./model/auth.js";
import { startCheckout } from "./model/seats.js";
import { internal } from "./_generated/api.js";
import { action, internalQuery } from "./_generated/server.js";

/**
 * Assert the caller is an owner/admin of the workspace (billing is privileged)
 * and return the workspace's (org) name + owner email — the customer profile the
 * checkout `attach` forwards to Autumn `customers.getOrCreate` so the customer is
 * materialised with name + email, not just an id. Internal query so the
 * `checkout` action can run the DB-backed authz guard. Reuses the T3
 * `requireRole` bridge; throws `ConvexError` when not allowed. Loads the owner
 * via the repo pattern (`normalizeId('users', ws.ownerId)`, as in `me`).
 */
export const assertBillingAdmin = internalQuery({
  args: { workspaceId: v.id("workspaces") },
  handler: async (
    ctx,
    { workspaceId },
  ): Promise<{ name: string | null; email: string | null }> => {
    await requireRole(ctx, workspaceId, ["owner", "admin"]);
    const ws = await ctx.db.get(workspaceId);
    if (ws === null) {
      return { name: null, email: null };
    }
    const ownerId = ctx.db.normalizeId("users", ws.ownerId);
    const owner = ownerId === null ? null : await ctx.db.get(ownerId);
    return { name: ws.name, email: owner?.email ?? null };
  },
});

/**
 * Start a checkout/upgrade for the workspace on a CHOSEN plan, returning the
 * Autumn billing URL to open. Owner/admin only. The workspace id is the Autumn
 * customer id.
 *
 * `planId` is the paid plan the upgrade UI selected (team / business /
 * unlimited). It is VALIDATED against the paid-plan allow-list inside the pure
 * SeatsService (an unknown/forged plan fails with `UnknownPlanError` →
 * `ConvexError` before any Autumn call). Defaults to the team plan (the entry
 * upsell) when omitted.
 */
export const checkout = action({
  args: {
    workspaceId: v.id("workspaces"),
    planId: v.optional(v.string()),
  },
  handler: async (ctx, { workspaceId, planId }): Promise<{ checkoutUrl: string }> => {
    // Authz first: only owner/admin may start a billing checkout. The same
    // query returns the customer profile (name + owner email) so the checkout
    // attach materialises the Autumn customer with a name + email, not just id.
    const customerData = await ctx.runQuery(
      internal.billing.assertBillingAdmin,
      { workspaceId },
    );

    const checkoutUrl = await startCheckout(workspaceId, planId, customerData);
    return { checkoutUrl };
  },
});
