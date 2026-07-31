/**
 * Worker endpoint: turn a CLOUD table's auto-run on or off (the agent's
 * `set_auto_run` tool).
 *
 * Auto-run is the table's policy for whether BILLED function columns re-run by
 * themselves when an upstream input changes. An agent that is about to rewrite a
 * column's config, or bulk-load rows it does not want enriched yet, turns it off
 * first and back on when it is ready — the same switch the toolbar shows, so the
 * user and the agent can never disagree about the policy.
 *
 * Member-attributed exactly like `setDedupe`: `GridService.setTableAutoRun`
 * resolves the table's workspace and asserts the `X-Gtmgrid-Member` user is a
 * member with cloud access (fail-closed: 401/403/402) before writing. Not metered
 * — setting a policy isn't a billable action. Returns `{ autoRun }`.
 */

import { GridService } from "@gtmgrid/services";
import { Effect } from "effect";
import { runWorkerAsMember } from "../_lib";
import { SetAutoRunSchema } from "../_schemas";

export const runtime = "nodejs";
export function POST(req: Request): Promise<Response> {
  return runWorkerAsMember(req, SetAutoRunSchema, (body) =>
    Effect.gen(function* () {
      const svc = yield* GridService;
      return yield* svc.setTableAutoRun(body.tableId, body.autoRun);
    }),
  );
}
