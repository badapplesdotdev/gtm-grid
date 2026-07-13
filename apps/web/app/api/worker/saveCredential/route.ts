/**
 * Worker endpoint: save a SHARED (workspace-scope) connector/AI credential.
 *
 * Backs the desktop "Use my local key" action: the sidecar decrypts the user's
 * LOCAL key in-process and posts the plaintext map here over TLS so it is
 * encrypted server-side via `CredentialService.saveCredential`. The plaintext
 * never enters the renderer and is never persisted raw.
 *
 * Member-attributed (NOT secret-gated): `runWorkerAsMember` resolves the
 * forwarded `X-Gtmgrid-Member` session token, and `saveCredential` asserts the
 * member belongs to `workspaceId` (fail-closed 401/403) before encrypting. Scope
 * is forced to `workspace` — this route only ever writes the shared cloud key, not
 * a personal one. Returns the upserted row id.
 */

import { CredentialService } from "@gtmgrid/services";
import { Effect } from "effect";
import { runWorkerAsMember } from "../_lib";
import { SaveCredentialSchema } from "../_schemas";

export const runtime = "nodejs";
/** Narrow an unknown body field to a non-empty plaintext string map. */
function isStringMap(v: unknown): v is Record<string, string> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const entries = Object.entries(v);
  return (
    entries.length > 0 && entries.every(([, val]) => typeof val === "string")
  );
}

export function POST(req: Request): Promise<Response> {
  return runWorkerAsMember(req, SaveCredentialSchema, (body) =>
    Effect.gen(function* () {
      if (!isStringMap(body.secrets)) {
        return yield* Effect.fail(
          new Error("secrets must be a non-empty string map"),
        );
      }
      const svc = yield* CredentialService;
      const id = yield* svc.saveCredential({
        workspaceId: body.workspaceId,
        extensionId: body.extensionId,
        scope: "workspace",
        name: body.name,
        secrets: body.secrets,
      });
      return { id };
    }),
  );
}
