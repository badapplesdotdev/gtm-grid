/**
 * Workspace-scoped PartyKit realtime tokens (TRI-3261) — the SERVER-GATING that
 * fixes the cross-tenant leak.
 *
 * The Supabase option-a realtime used a PUBLIC Broadcast channel and a JWT that
 * carried NO workspace claim, so any signed-in user could mint `realtime.token`
 * and eavesdrop on another workspace's grid events. The fix is a token that
 * BINDS the connection to one workspace: `realtime.token` is now a
 * `workspaceProcedure` (membership verified) that mints a token whose
 * `workspaceId` claim must equal the PartyKit room's workspace id, checked in the
 * party's `onBeforeConnect`.
 *
 * This module is PURE and depends only on `jose` (HS256). It is shared by BOTH
 * the apps/web router (which mints) and the apps/party server (which verifies +
 * authorizes), so the token contract has exactly one definition.
 *
 *   - {@link mintPartyToken}  — sign `{ sub, workspaceId, exp }` (HS256, secret).
 *   - {@link verifyPartyToken} — verify signature + expiry, return claims.
 *   - {@link authorizeGridConnection} — the PURE authorization decision the party
 *     applies in `onBeforeConnect`: a token authorizes a room ONLY when it is
 *     present, validly signed, unexpired, AND its `workspaceId` matches the room.
 */

import { jwtVerify, SignJWT } from "jose";

/** Default lifetime of a minted party token, in SECONDS (1 hour). */
export const PARTY_TOKEN_TTL_SECONDS = 60 * 60;

/** The claims a workspace-scoped party token carries. */
export interface PartyTokenClaims {
  /** The user id (Better Auth) — drives presence (`auth.uid()`-equivalent). */
  readonly sub: string;
  /** The workspace the token authorizes. The room's workspace MUST equal this. */
  readonly workspaceId: string;
  /** Expiry, epoch seconds. */
  readonly exp: number;
  /** Issued-at, epoch seconds. */
  readonly iat: number;
}

/** Options for {@link mintPartyToken}. */
export interface MintPartyTokenOptions {
  /** The user id — becomes `sub` (presence id). */
  readonly userId: string;
  /** The workspace the token is scoped to — becomes the `workspaceId` claim. */
  readonly workspaceId: string;
  /**
   * HS256 signing secret. Defaults to `process.env.PARTY_AUTH_SECRET`; pass
   * explicitly in tests. Throws if neither is available.
   */
  readonly secret?: string;
  /** Token lifetime in seconds. Defaults to {@link PARTY_TOKEN_TTL_SECONDS}. */
  readonly expiresInSeconds?: number;
}

/**
 * Mint a workspace-scoped HS256 party token carrying `{ sub, workspaceId, exp }`.
 * Returns the signed compact-serialized token string.
 */
export async function mintPartyToken(
  options: MintPartyTokenOptions,
): Promise<string> {
  const secret = options.secret ?? process.env.PARTY_AUTH_SECRET;
  if (!secret) {
    throw new Error(
      "PARTY_AUTH_SECRET is not set. It is required to mint workspace-scoped " +
        "PartyKit realtime tokens (HS256). See .env.example.",
    );
  }
  const ttl = options.expiresInSeconds ?? PARTY_TOKEN_TTL_SECONDS;
  const key = new TextEncoder().encode(secret);
  return await new SignJWT({ workspaceId: options.workspaceId })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(options.userId)
    .setIssuedAt()
    .setExpirationTime(`${ttl}s`)
    .sign(key);
}

/**
 * Verify a party token's signature + expiry under `secret` and return its typed
 * claims. Rejects (throws) on a bad signature, an expired token, or a payload
 * missing the required `sub`/`workspaceId` claims.
 */
export async function verifyPartyToken(
  token: string,
  secret: string,
): Promise<PartyTokenClaims> {
  const key = new TextEncoder().encode(secret);
  const { payload } = await jwtVerify(token, key, { algorithms: ["HS256"] });
  const { sub, workspaceId, exp, iat } = payload as {
    sub?: unknown;
    workspaceId?: unknown;
    exp?: unknown;
    iat?: unknown;
  };
  if (
    typeof sub !== "string" ||
    typeof workspaceId !== "string" ||
    typeof exp !== "number" ||
    typeof iat !== "number"
  ) {
    throw new Error("party token is missing required claims");
  }
  return { sub, workspaceId, exp, iat };
}

/** The room id of a grid party: `${workspaceId}:${tableId}`. */
export const gridRoomId = (workspaceId: string, tableId: string): string =>
  `${workspaceId}:${tableId}`;

/**
 * Extract the workspace id from a grid room id (`${workspaceId}:${tableId}`).
 * The table id may itself contain colons; only the FIRST segment is the
 * workspace, so split on the first `:` only. Returns `null` when the room id has
 * no `:` (malformed).
 */
export const workspaceIdFromRoomId = (roomId: string): string | null => {
  const idx = roomId.indexOf(":");
  return idx <= 0 ? null : roomId.slice(0, idx);
};

/** The outcome of {@link authorizeGridConnection}: authorized + the claims, or rejected + why. */
export type GridConnectionDecision =
  | { readonly ok: true; readonly claims: PartyTokenClaims }
  | { readonly ok: false; readonly reason: GridRejectReason };

/** Why a connection was rejected — exhaustive so the party can log precisely. */
export type GridRejectReason =
  | "missing-token"
  | "bad-signature"
  | "expired"
  | "malformed-room"
  | "workspace-mismatch";

/**
 * The PURE authorization decision the grid party applies in `onBeforeConnect`.
 * A connection is authorized ONLY when ALL hold:
 *   - a token is present,
 *   - it is validly signed under `secret` (HS256),
 *   - it is NOT expired (`exp` > `now`, seconds),
 *   - and its `workspaceId` claim EQUALS the room's workspace id.
 *
 * Any failure rejects with a precise reason — this is the tenant-isolation
 * guarantee, unit-tested against wrong-workspace / expired / bad-signature /
 * missing-token. Kept pure (no I/O) so it is exhaustively testable: pass the
 * caller's clock as `nowSeconds`.
 */
export async function authorizeGridConnection(args: {
  /** The `?token=` query param, or `null`/`undefined` when absent. */
  readonly token: string | null | undefined;
  /** The party room id (`${workspaceId}:${tableId}`). */
  readonly roomId: string;
  /** The HS256 verification secret (`PARTY_AUTH_SECRET`). */
  readonly secret: string;
  /** Current time, epoch SECONDS (so tests can pin the clock). */
  readonly nowSeconds: number;
}): Promise<GridConnectionDecision> {
  if (!args.token) return { ok: false, reason: "missing-token" };

  const roomWorkspaceId = workspaceIdFromRoomId(args.roomId);
  if (roomWorkspaceId === null) {
    return { ok: false, reason: "malformed-room" };
  }

  let claims: PartyTokenClaims;
  try {
    claims = await verifyPartyToken(args.token, args.secret);
  } catch (cause) {
    // jose throws `JWTExpired` (code ERR_JWT_EXPIRED) on a stale `exp`; map it to
    // the precise reason. Everything else (bad signature, missing claims) is a
    // signature/structure failure.
    const code = (cause as { code?: unknown } | null)?.code;
    if (code === "ERR_JWT_EXPIRED") return { ok: false, reason: "expired" };
    return { ok: false, reason: "bad-signature" };
  }

  // Defence-in-depth against the caller's clock vs jose's: re-check expiry with
  // the explicitly-supplied `nowSeconds` so the decision is deterministic.
  if (claims.exp <= args.nowSeconds) {
    return { ok: false, reason: "expired" };
  }
  if (claims.workspaceId !== roomWorkspaceId) {
    return { ok: false, reason: "workspace-mismatch" };
  }
  return { ok: true, claims };
}
