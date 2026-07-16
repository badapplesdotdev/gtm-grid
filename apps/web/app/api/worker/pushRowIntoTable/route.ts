/**
 * Worker endpoint: the table.push (v2, webhook-style) write. Delivers ONE
 * source row into a sibling table through its PUSH CONNECTION — the service
 * finds-or-creates the connection, applies ITS stored mapping (edited from the
 * TARGET table) to the whole source row, lands the raw payload in the target's
 * "Pushed data" column, dedupes on the key, meters once per record, and
 * publishes realtime. Same-project scoping enforced in the service.
 *
 * `autoRunTarget` (Clay parity) is honoured AFTER the write by emitting the
 * `table/row.pushed` Inngest event — best-effort: the row is already written
 * and metered, so a failed enqueue never fails the push.
 */

import { WebhookService } from "@gtmgrid/services";
import { Effect } from "effect";
import { runWorkerSecretOrMember } from "../_lib";
import { PushRowIntoTableSchema } from "../_schemas";
import { inngest } from "../../../../lib/inngest/client";

export const runtime = "nodejs";

export function POST(req: Request): Promise<Response> {
  return runWorkerSecretOrMember(req, PushRowIntoTableSchema, (body) =>
    Effect.gen(function* () {
      const svc = yield* WebhookService;
      const result = yield* svc.pushRecord({
        sourceTableId: body.sourceTableId,
        sourceRowId: body.sourceRowId,
        sourceColumnId: body.sourceColumnId ?? null,
        targetTableId: body.targetTableId,
        mode: body.mode,
        keyColumnName: body.keyColumnName ?? null,
        keyValue: body.keyValue,
      });
      if (body.autoRunTarget === true) {
        yield* Effect.promise(() =>
          inngest
            .send({
              name: "table/row.pushed",
              data: {
                tableId: result.tableId,
                workspaceId: result.workspaceId,
                rowId: result.rowId,
                recordId: null,
              },
            })
            .then(
              () => undefined,
              () => undefined, // best-effort: never fail a completed push
            ),
        );
      }
      return { rowId: result.rowId, created: result.created };
    }),
  );
}
