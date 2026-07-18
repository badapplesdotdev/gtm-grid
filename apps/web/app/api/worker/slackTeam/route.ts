/**
 * Worker endpoint: the Slack TEAM id a workspace is connected to, or `null`.
 * Secret-gated bearer.
 *
 * Exists solely as the Events receiver's tenant gate. Slack delivers EVERY
 * installation of an app to ONE app-global Request URL, signed with ONE
 * app-global signing secret — so a valid v0 signature proves "Slack sent this on
 * behalf of this APP", NOT "this came from the workspace that owns this
 * webhook". The receiver compares this team against the event's to reject
 * cross-tenant events.
 *
 * Returns ONLY the team id — never the secret map. The receiver has no business
 * holding an access token, and a narrower response is a narrower blast radius if
 * this endpoint is ever reachable in a way it shouldn't be.
 */

import { SlackConnectionService } from "@gtmgrid/services";
import { Effect } from "effect";
import { runWorker } from "../_lib";
import { SlackTeamSchema } from "../_schemas";

export const runtime = "nodejs";

export function POST(req: Request): Promise<Response> {
  return runWorker(req, SlackTeamSchema, (body) =>
    Effect.gen(function* () {
      const svc = yield* SlackConnectionService;
      const teamId = yield* svc.connectedTeamIdForWorker(body.workspaceId);
      return { teamId };
    }),
  );
}
