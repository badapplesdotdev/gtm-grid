/**
 * `/api/oauth/google/picker` — the Google Picker's server side.
 *
 * `GET`  → the config the Picker needs to open (access token, developer key, app id).
 * `POST` → persist the files the user selected.
 *
 * WHY THIS EXISTS AT ALL. Under the `drive.file` scope a grant conveys no
 * blanket access: each spreadsheet is authorised individually, by the user, in
 * Google's own Picker widget. There is no server-side API that can substitute
 * for that — so the flow has to leave the server, run JS in a browser holding a
 * live access token, and hand the result back. These two handlers are that
 * round trip.
 *
 * THE TRUST BOUNDARY IS THE SIGNED STATE, NOT A SESSION. The picker page is
 * opened with `openExternal`, so the system browser carries no gtmgrid.dev
 * cookie — exactly as for the OAuth callback. `state` is minted server-side by
 * `google.pickerUrl` only after `requireMember`, is HMAC-signed, carries the
 * provider id, and expires in 15 minutes. Verifying it here proves the workspace
 * claim came from a member, so neither handler consults a session.
 *
 * GET HANDS AN ACCESS TOKEN TO THE BROWSER. That is not a leak to paper over —
 * it is how the Picker works, and the exposure is deliberately bounded: the
 * token is `drive.file`-only (it can enumerate nothing the user has not already
 * picked), lives an hour, and is fetched fresh through `OAuthCredentialService`
 * so a stale one is refreshed server-side first. The client secret and the
 * refresh token never leave the server.
 */

import { GOOGLE_ADAPTER, GOOGLE_CONNECTION_SLOT, GoogleConnectionService, appLayer } from "@gtmgrid/services";
import { OAuthCredentialService } from "@gtmgrid/services";
import { CredentialRepo, CryptoService } from "@gtmgrid/services";
import { Effect, ManagedRuntime, Option } from "effect";
import type { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/**
 * Verify the signed state and hand back its claims.
 *
 * A single `null` return for every failure mode (absent, forged, expired, minted
 * for another provider) is deliberate: distinguishing them tells an attacker
 * which part of a guess was right.
 */
const claimsFrom = async (state: string) =>
  state === "" ? null : await Effect.runPromise(GOOGLE_ADAPTER.verifyState(state));

export async function GET(req: NextRequest): Promise<Response> {
  const state = req.nextUrl.searchParams.get("state") ?? "";
  const claims = await claimsFrom(state);
  if (claims === null) return json({ error: "invalid_or_expired_state" }, 400);

  const developerKey = process.env.GOOGLE_PICKER_API_KEY ?? "";
  const appId = process.env.GOOGLE_PICKER_APP_ID ?? "";
  const clientId = process.env.GOOGLE_CLIENT_ID ?? "";
  if (developerKey === "" || appId === "") {
    // A distinct, NAMED failure rather than a blank Picker. Without these the
    // widget fails inside Google's own JS with an opaque error, and an operator
    // has no way to tell a misconfiguration from a broken grant.
    return json({ error: "picker_not_configured", missing: developerKey === "" ? "GOOGLE_PICKER_API_KEY" : "GOOGLE_PICKER_APP_ID" }, 500);
  }

  const { db } = await import("@gtmgrid/db/client");
  const rt = ManagedRuntime.make(appLayer({ db, userId: claims.userId }));
  try {
    const token = await rt.runPromise(
      Effect.gen(function* () {
        // Read the stored row directly rather than through the member-gated
        // service: there is no session here, and the state has already proved
        // membership. This mirrors the callback's write path.
        const repo = yield* CredentialRepo;
        const crypto = yield* CryptoService;
        const row = yield* repo.findSharedForWorker({
          workspaceId: claims.workspaceId,
          extensionId: GOOGLE_CONNECTION_SLOT,
        });
        if (Option.isNone(row)) return null;
        const stored = yield* crypto.decrypt(claims.workspaceId, row.value.secretsEnc);
        // Refresh BEFORE handing the token out — an expired token makes the
        // Picker fail with a generic "cannot load" that reads as our bug.
        const oauth = yield* OAuthCredentialService;
        const fresh = yield* oauth
          .freshSecrets(claims.workspaceId, GOOGLE_CONNECTION_SLOT, stored)
          .pipe(Effect.orElseSucceed(() => stored));
        return fresh.accessToken ?? null;
      }).pipe(Effect.orElseSucceed(() => null)),
    );

    if (token === null) return json({ error: "not_connected" }, 409);
    return json({ accessToken: token, developerKey, appId, clientId });
  } finally {
    await rt.dispose();
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  const state = req.nextUrl.searchParams.get("state") ?? "";
  const claims = await claimsFrom(state);
  if (claims === null) return json({ error: "invalid_or_expired_state" }, 400);

  const body: unknown = await req.json().catch(() => null);
  const rawFiles = body !== null && typeof body === "object" ? Reflect.get(body, "files") : undefined;
  if (!Array.isArray(rawFiles)) return json({ error: "bad_request" }, 400);

  // Total narrowing over an untrusted body: anything not shaped like a file is
  // dropped rather than coerced, so a malformed pick cannot write junk ids that
  // later fail at the Sheets API with no explanation.
  const files = rawFiles.flatMap((entry: unknown) => {
    if (entry === null || typeof entry !== "object") return [];
    const id = Reflect.get(entry, "id");
    const name = Reflect.get(entry, "name");
    if (typeof id !== "string" || id === "") return [];
    return [{ id, name: typeof name === "string" ? name : id }];
  });
  if (files.length === 0) return json({ error: "no_valid_files" }, 400);

  const { db } = await import("@gtmgrid/db/client");
  const rt = ManagedRuntime.make(appLayer({ db, userId: claims.userId }));
  try {
    const saved = await rt.runPromise(
      Effect.gen(function* () {
        const connection = yield* GoogleConnectionService;
        return yield* connection.addPickedFiles({ workspaceId: claims.workspaceId, files });
      }).pipe(Effect.orElseSucceed(() => false)),
    );
    return json({ saved, count: files.length }, saved ? 200 : 409);
  } finally {
    await rt.dispose();
  }
}
