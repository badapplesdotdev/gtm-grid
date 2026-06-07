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
import { invitationsRouter } from "./routers/invitations";
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

  /** Workspace invitations (invite -> accept lifecycle). */
  invitations: invitationsRouter,

  // ── W2 router slots ──────────────────────────────────────────────────────
  // W2: projects: projectsRouter,
  // W2: tables: tablesRouter,
  // W2: columns: columnsRouter,
  // W2: rows: rowsRouter,
  // W2: credentials: credentialsRouter,
});

/** The API type the typed client (W2) consumes. */
export type AppRouter = typeof appRouter;
