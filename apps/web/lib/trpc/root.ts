/**
 * The root `appRouter` — the single tRPC API surface.
 *
 * W1 (this lane) wires the WORKED EXAMPLE that proves the Effect-DI pattern
 * end-to-end:
 *   - `health` — a public procedure (no auth, no DB) for liveness checks.
 *   - `workspace.get` — a `workspaceProcedure` that resolves `WorkspaceService`
 *     from the request runtime and runs an Effect; membership is asserted by the
 *     procedure middleware, so a non-member never reaches the body.
 *
 * W2 lanes add their routers in the SLOTS below (see the empty `// W2:` comments)
 * by exporting a router from `@gtmgrid/services`-backed procedures and merging it
 * here. Nothing else in the stack changes.
 */

import { WorkspaceService } from "@gtmgrid/services";
import { Effect } from "effect";
import { authRouter } from "./routers/auth";
import { billingRouter } from "./routers/billing";
import { credentialsRouter } from "./routers/credentials";
import { crmRouter } from "./routers/crm";
import { googleRouter } from "./routers/google";
import { sheetsRouter } from "./routers/sheets";
import { slackRouter } from "./routers/slack";
import { extensionsRouter } from "./routers/extensions";
import { gridRouter } from "./routers/grid";
import { invitationsRouter } from "./routers/invitations";
import { realtimeRouter } from "./routers/realtime";
import { presenceRouter } from "./routers/presence";
import { pipelinesRouter } from "./routers/pipelines";
import { shareRouter } from "./routers/share";
import { webhooksRouter } from "./routers/webhooks";
import { signalsRouter } from "./routers/signals";
import { workspacesRouter } from "./routers/workspaces";
import {
  publicProcedure,
  router,
  runEffect,
  workspaceProcedure,
} from "./trpc";

/** Workspace-scoped procedures. The W1 worked example lives here. */
const workspaceRouter = router({
  /**
   * Return the current workspace. `workspaceProcedure` has already asserted the
   * caller is a member (rejecting non-members with FORBIDDEN); the body resolves
   * `WorkspaceService` from the runtime and runs the Effect program.
   */
  get: workspaceProcedure.query(({ ctx, input }) =>
    runEffect(
      ctx.runtime,
      Effect.gen(function* () {
        const svc = yield* WorkspaceService;
        return yield* svc.getWorkspace(input.workspaceId);
      }),
    ),
  ),
});

/** The composed API. */
export const appRouter = router({
  /** Public liveness probe — no auth, no DB. */
  health: publicProcedure.query(() => ({
    status: "ok" as const,
    timestamp: Date.now(),
  })),

  workspace: workspaceRouter,

  /**
   * Auth: `enabledProviders` — booleans-only OAuth/email-flow gating for the
   * sign-in UI (ports the Convex public query convex/auth.ts:153). No secrets.
   */
  auth: authRouter,

  // ── W2 routers ─────────────────────────────────────────────────────────────
  /** Workspaces: `me`, `listMembers`, `createWorkspace` (ports convex/workspaces.ts). */
  workspaces: workspacesRouter,
  /** Billing: `checkout` (ports convex/billing.ts; Autumn upgrade URL). */
  billing: billingRouter,
  /** Workspace invitations (invite -> accept lifecycle). */
  invitations: invitationsRouter,
  /** Desktop activity heartbeat → `users.last_active_at` (lifecycle emails). */
  presence: presenceRouter,
  /** Connector credentials — encrypt/save, member-gated decrypt, metadata list. */
  credentials: credentialsRouter,
  /** Member-gated webhook config CRUD (TRI-3250). */
  webhooks: webhooksRouter,
  /** Member-gated Social Signals (Trigify) bindings; recurring poll runs in Inngest. */
  signals: signalsRouter,
  /** Member-gated Attio CRM-sync bindings; sync execution runs in Inngest. */
  crm: crmRouter,
  slack: slackRouter,
  google: googleRouter,
  /** Google Sheet -> table import bindings; sync execution runs in Inngest. */
  sheets: sheetsRouter,
  /** Member-gated connector extensions (TRI-3250). */
  extensions: extensionsRouter,
  /**
   * Grid data: projects/tables/columns/rows/cells (TRI-3248). `getTable` returns
   * the full grid in one read; mutations meter cloud actions on the write path.
   */
  grid: gridRouter,
  /**
   * Realtime: `token` mints a WORKSPACE-SCOPED token the client uses to open a
   * server-gated PartyKit grid connection for live grid + presence (TRI-3261).
   */
  realtime: realtimeRouter,
  /** Frozen, read-only table snapshots shared through public capability URLs. */
  share: shareRouter,
  /** Reusable pipeline drafts, immutable deployments, table bindings and runs. */
  pipelines: pipelinesRouter,
});

/** The API type the typed client (W2) consumes. */
export type AppRouter = typeof appRouter;
