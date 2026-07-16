/**
 * Worker endpoint: create a MANUAL column on a sibling table — table.push's
 * `createMissingColumns`. Same-project target resolution + metering (one cloud
 * action, mirroring the member addColumn mutation) live in the service.
 * Secret-or-member trust, like the other cross-table action routes.
 */

import { WebhookService } from "@gtmgrid/services";
import { Effect } from "effect";
import { runWorkerSecretOrMember } from "../_lib";
import { CreateColumnInTableSchema } from "../_schemas";

export const runtime = "nodejs";

export function POST(req: Request): Promise<Response> {
  return runWorkerSecretOrMember(req, CreateColumnInTableSchema, (body) =>
    Effect.gen(function* () {
      const svc = yield* WebhookService;
      return yield* svc.createColumnInTable({
        sourceTableId: body.sourceTableId,
        targetTableId: body.targetTableId,
        name: body.name,
        ...(body.type !== undefined ? { type: body.type } : {}),
      });
    }),
  );
}
