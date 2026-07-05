/**
 * Typed error hierarchy for the CRM-sync subsystem (TRI: crm-sync). Every
 * failure an Attio call or a sync run can produce is one of these tags —
 * `crm/error-copy.ts` maps each tag to the human-readable copy + run status
 * that end users see, and `isTransientCrmError` drives the silent retry policy.
 *
 * Grouping (mirrors how the sync loop reacts):
 * - TRANSIENT  → retried silently with backoff; only surfaces if exhausted.
 * - AUTH       → pauses the binding until the user reconnects Attio.
 * - PARTIAL    → the run continues/lands what it can and reports what it skipped.
 * - HARD       → the run fails with actionable copy.
 */

import { Data } from "effect";

// ── Transient (silently retried) ──────────────────────────────────────────────

/** Attio returned 429. `retryAfterMs` honors the Retry-After header when sent. */
export class AttioRateLimitError extends Data.TaggedError("AttioRateLimitError")<{
  readonly retryAfterMs?: number;
}> {}

/** Attio returned a 5xx. */
export class AttioServerError extends Data.TaggedError("AttioServerError")<{
  readonly status: number;
}> {}

/** The fetch itself rejected (DNS, connection reset, timeout). */
export class AttioNetworkError extends Data.TaggedError("AttioNetworkError")<{
  readonly cause: unknown;
}> {}

// ── Auth (pauses the binding; user must reconnect) ────────────────────────────

/**
 * Attio rejected the token (401 after a refresh attempt, or the refresh itself
 * was refused). The connection is dead until the user re-runs OAuth.
 */
export class AttioAuthRevoked extends Data.TaggedError("AttioAuthRevoked")<{
  readonly detail?: string;
}> {}

/** No Attio credential exists for this workspace (deleted or never connected). */
export class CrmConnectionMissing extends Data.TaggedError("CrmConnectionMissing") {}

// ── Recoverable-partial (run lands what it can) ───────────────────────────────

/**
 * One or more mapped attributes no longer exist upstream (deleted/renamed in
 * Attio). The run skips those columns, syncs the rest, and reports the labels.
 */
export class AttioSchemaDriftError extends Data.TaggedError("AttioSchemaDriftError")<{
  readonly missingAttrs: ReadonlyArray<string>;
}> {}

/** The bound object/list itself is gone upstream (404 on the source). */
export class AttioSourceGoneError extends Data.TaggedError("AttioSourceGoneError")<{
  readonly sourceLabel: string;
}> {}

/**
 * The plan's row cap was reached mid-pull. Soft: the run keeps everything under
 * the cap and reports the truncation.
 */
export class RowCapReached extends Data.TaggedError("RowCapReached")<{
  readonly cap: number;
}> {}

// ── Hard ──────────────────────────────────────────────────────────────────────

/** Attio rejected the request as malformed (400) — usually an inexpressible filter. */
export class AttioRequestError extends Data.TaggedError("AttioRequestError")<{
  readonly status: number;
  readonly detail?: string;
}> {}

/** Catch-all for failures that don't fit a more specific tag. */
export class CrmSyncError extends Data.TaggedError("CrmSyncError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** Union of every CRM-sync failure. */
export type CrmError =
  | AttioRateLimitError
  | AttioServerError
  | AttioNetworkError
  | AttioAuthRevoked
  | CrmConnectionMissing
  | AttioSchemaDriftError
  | AttioSourceGoneError
  | RowCapReached
  | AttioRequestError
  | CrmSyncError;

/** Failures worth an in-process retry: rate limit, 5xx, or network. */
export const isTransientCrmError = (e: CrmError): boolean =>
  e._tag === "AttioRateLimitError" ||
  e._tag === "AttioServerError" ||
  e._tag === "AttioNetworkError";
