/**
 * Production Live-adapter CONFIG decoding for the cloud tier.
 *
 * The Convex Live port adapters (convex/model/crypto.ts, convex/model/seats.ts)
 * wire the pure @gtmgrid/cloud domain to the real deployment ENV:
 *   - the credential master key from `CREDENTIALS_MASTER_KEY`, and
 *   - the Autumn secret key from `AUTUMN_SECRET_KEY`.
 *
 * Those Convex files are `"use node"` and import the generated Convex runtime,
 * so they cannot be unit-tested in the root `packages/*` vitest graph. The
 * fiddly, error-prone part of building those adapters is decoding/validating the
 * env — exactly the part that must fail CLOSED on a missing or malformed value.
 * So that logic lives here as pure functions the Convex adapters delegate to,
 * making the construction + env-missing paths exhaustively unit-testable with no
 * Convex codegen, mirroring the rest of @gtmgrid/cloud.
 */

import { Data } from "effect";
import { EncryptError, KEY_BYTES } from "./crypto.js";

/**
 * Raised when a required deployment secret (e.g. `AUTUMN_SECRET_KEY`) is missing
 * or empty. The Convex seats adapter maps this to a `ConvexError` so a
 * misconfigured deployment fails legibly instead of silently constructing a
 * broken SDK client.
 */
export class MissingSecretError extends Data.TaggedError("MissingSecretError")<{
  readonly message: string;
  readonly name: string;
}> {}

/**
 * Decode `CREDENTIALS_MASTER_KEY` (a 64-char hex string OR base64 of 32 bytes)
 * into a raw 32-byte key. Anything that does not decode to exactly
 * {@link KEY_BYTES} bytes — including a missing/empty value — is a
 * misconfiguration and throws {@link EncryptError} (fail-closed: never encrypt
 * under, or decrypt with, a bad key). Pure: the caller passes the raw env value.
 */
export function decodeMasterKeyBytes(
  raw: string | undefined,
): Uint8Array {
  if (raw === undefined || raw === "") {
    throw new EncryptError({
      message: "CREDENTIALS_MASTER_KEY is not set on the Convex deployment.",
    });
  }
  const trimmed = raw.trim();
  // Prefer hex when the string is exactly 64 hex chars; else try base64.
  const isHex = /^[0-9a-fA-F]{64}$/.test(trimmed);
  const buf = isHex
    ? Buffer.from(trimmed, "hex")
    : Buffer.from(trimmed, "base64");
  if (buf.byteLength !== KEY_BYTES) {
    throw new EncryptError({
      message:
        `CREDENTIALS_MASTER_KEY must decode to ${KEY_BYTES} bytes ` +
        `(got ${buf.byteLength}); use 64 hex chars or base64 of 32 bytes.`,
    });
  }
  return new Uint8Array(buf);
}

/**
 * Assert a required deployment secret `name` has a non-empty `value`, returning
 * it. Throws {@link MissingSecretError} (fail-closed) on a missing/empty value
 * so the Convex adapter never constructs a client around an absent key.
 */
export function requireSecret(name: string, value: string | undefined): string {
  if (value === undefined || value === "") {
    throw new MissingSecretError({
      message: `${name} is not set on the Convex deployment.`,
      name,
    });
  }
  return value;
}
