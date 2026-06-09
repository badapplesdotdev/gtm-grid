/**
 * Worker endpoint: list a CLOUD project's tables with their column + row counts
 * (the agent's project-wide `list_tables` tool in cloud mode — TRI-3299).
 *
 * Member-attributed: unlike the table-scoped read endpoints (secret-only), the
 * agent's project tools resolve the owning workspace from the `projectId` and
 * assert the forwarded `X-Gtmgrid-Member` user belongs to it via
 * `GridService` → `MembershipService.requireMember` (fail-closed: a non-member
 * is 403, a missing/invalid member token is 401). A pure read — not metered.
 */

import { GridService } from "@gtmgrid/services";
import { Effect } from "effect";
import { runWorkerAsMember } from "../_lib";

export const runtime = "nodejs";

export function POST(req: Request): Promise<Response> {
  return runWorkerAsMember(req, (body: { projectId: string }) =>
    Effect.gen(function* () {
      const svc = yield* GridService;
      return yield* svc.listTablesWithCounts(body.projectId);
    }),
  );
}
