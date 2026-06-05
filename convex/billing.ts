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
 * Assert the caller is an owner/admin of the workspace (billing is privileged).
 * Internal query so the `checkout` action can run the DB-backed authz guard.
 * Reuses the T3 `requireRole` bridge; throws `ConvexError` when not allowed.
 */
export const assertBillingAdmin = internalQuery({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, { workspaceId }) => {
    await requireRole(ctx, workspaceId, ["owner", "admin"]);
    return null;
  },
});

/**
 * Start a checkout/upgrade for the workspace, returning the Autumn billing URL
 * to open. Owner/admin only. The workspace id is the Autumn customer id; the
 * plan defaults to the team plan when omitted.
 */
export const checkout = action({
  args: {
    workspaceId: v.id("workspaces"),
    planId: v.optional(v.string()),
  },
  handler: async (ctx, { workspaceId, planId }): Promise<{ checkoutUrl: string }> => {
    // Authz first: only owner/admin may start a billing checkout.
    await ctx.runQuery(internal.billing.assertBillingAdmin, { workspaceId });

    const checkoutUrl = await startCheckout(workspaceId, planId);
    return { checkoutUrl };
  },
});
