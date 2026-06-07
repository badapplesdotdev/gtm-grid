/**
 * Supabase-compatible JWT minting (TRI-3244) — consumed by W3 realtime.
 *
 * Supabase Realtime / RLS authorize a client by a JWT signed (HS256) with the
 * project's `SUPABASE_JWT_SECRET`. Better Auth owns the session; this helper
 * bridges a signed-in Better Auth user to a Supabase-shaped token so the desktop
 * /web client can open a Realtime channel as that user WITHOUT a second login.
 *
 * The minted claims mirror what Supabase Auth issues so RLS policies that read
 * `auth.uid()` / `auth.role()` work unchanged:
 *   - `sub`   — the Better Auth user id (this is what `auth.uid()` returns),
 *   - `role`  — "authenticated" (the Postgres role RLS checks),
 *   - `aud`   — "authenticated",
 *   - `iat` / `exp` — issued-at + expiry (default 1 hour).
 *
 * Uses `jose` (already in the tree) for the HS256 sign. No live DB or network.
 */

import { SignJWT } from "jose";

/** Default lifetime of a minted Supabase JWT, in SECONDS (1 hour). */
export const SUPABASE_JWT_TTL_SECONDS = 60 * 60;

/** The Postgres role Supabase RLS expects for a signed-in user. */
const AUTHENTICATED_ROLE = "authenticated";

/** Options for {@link mintSupabaseJwt}. */
export interface MintSupabaseJwtOptions {
  /** Better Auth user id — becomes the `sub` claim (`auth.uid()`). */
  readonly userId: string;
  /**
   * HS256 signing secret. Defaults to `process.env.SUPABASE_JWT_SECRET`; pass
   * explicitly in tests. Throws if neither is available.
   */
  readonly secret?: string;
  /** Token lifetime in seconds. Defaults to {@link SUPABASE_JWT_TTL_SECONDS}. */
  readonly expiresInSeconds?: number;
  /**
   * Extra claims merged into the payload (e.g. `email`). Reserved claims set by
   * this function (sub/role/aud/iat/exp) take precedence.
   */
  readonly extraClaims?: Readonly<Record<string, unknown>>;
}

/**
 * Mint a Supabase-compatible HS256 JWT carrying the given Better Auth user id.
 * Returns the signed compact-serialized token string.
 */
export async function mintSupabaseJwt(
  options: MintSupabaseJwtOptions,
): Promise<string> {
  const secret = options.secret ?? process.env.SUPABASE_JWT_SECRET;
  if (!secret) {
    throw new Error(
      "SUPABASE_JWT_SECRET is not set. It is required to mint Supabase-" +
        "compatible realtime tokens (HS256). See .env.example.",
    );
  }

  const ttl = options.expiresInSeconds ?? SUPABASE_JWT_TTL_SECONDS;
  const key = new TextEncoder().encode(secret);

  return await new SignJWT({
    ...options.extraClaims,
    role: AUTHENTICATED_ROLE,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(options.userId)
    .setAudience(AUTHENTICATED_ROLE)
    .setIssuedAt()
    .setExpirationTime(`${ttl}s`)
    .sign(key);
}
