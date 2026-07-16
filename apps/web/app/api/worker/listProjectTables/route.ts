/**
 * Worker endpoint: list the SIBLING tables of a run's source table (same
 * project) — the table.push / table.lookup gateway's candidate-target list.
 *
 * Secret-or-member: the desktop's cloud run lane authenticates as the signed-in
 * member (asserted against the SOURCE table's workspace in the service); the
 * headless Inngest enricher passes on the worker secret. Same-project scoping
 * is enforced in `WebhookService.listProjectTables`. A pure read — not metered.
 */

import { WebhookService } from "@gtmgrid/services";
import { Effect } from "effect";
import { runWorkerSecretOrMember } from "../_lib";
import { ListProjectTablesSchema } from "../_schemas";

export const runtime = "nodejs";

export function POST(req: Request): Promise<Response> {
  return runWorkerSecretOrMember(req, ListProjectTablesSchema, (body) =>
    Effect.gen(function* () {
      const svc = yield* WebhookService;
      return yield* svc.listProjectTables(body.sourceTableId);
    }),
  );
}
