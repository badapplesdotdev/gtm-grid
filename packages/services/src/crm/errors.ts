/**
 * Typed error hierarchy for the CRM-sync subsystem (TRI: crm-sync). Every
 * failure a CRM call or a sync run can produce is one of these tags —
 * `crm/error-copy.ts` maps each tag to the human-readable copy + run status
 * that end users see, and `isTransientCrmError` drives the silent retry policy.
 *
 * Provider-neutral: each tag carries `provider`, the DISPLAY name of the CRM
 * ("Attio", "HubSpot") so copy can name the right product without a parallel
 * tag set per provider.
 *
 * Grouping (mirrors how the sync loop reacts):
 * - TRANSIENT  → retried silently with backoff; only surfaces if exhausted.
 * - AUTH       → pauses the binding until the user reconnects the CRM.
 * - PARTIAL    → the run continues/lands what it can and reports what it skipped.
 * - HARD       → the run fails with actionable copy.
 */

import { Data } from "effect";

// ── Transient (silently retried) ──────────────────────────────────────────────

/** The CRM returned 429. `retryAfterMs` honors the Retry-After header when sent. */
export class CrmRateLimitError extends Data.TaggedError("CrmRateLimitError")<{
  readonly provider: string;
  readonly retryAfterMs?: number;
}> {}

/** The CRM returned a 5xx. */
export class CrmServerError extends Data.TaggedError("CrmServerError")<{
  readonly provider: string;
  readonly status: number;
}> {}

/** The fetch itself rejected (DNS, connection reset, timeout). */
export class CrmNetworkError extends Data.TaggedError("CrmNetworkError")<{
  readonly provider: string;
  readonly cause: unknown;
}> {}

// ── Auth (pauses the binding; user must reconnect) ────────────────────────────

/**
 * The CRM rejected the token (401 after a refresh attempt, or the refresh
 * itself was refused). The connection is dead until the user re-runs OAuth.
 */
export class CrmAuthRevoked extends Data.TaggedError("CrmAuthRevoked")<{
  readonly provider: string;
  readonly detail?: string;
}> {}

/** No CRM credential exists for this workspace (deleted or never connected). */
export class CrmConnectionMissing extends Data.TaggedError("CrmConnectionMissing")<{
  readonly provider: string;
}> {}

// ── Recoverable-partial (run lands what it can) ───────────────────────────────

/**
 * One or more mapped attributes no longer exist upstream (deleted/renamed in
 * the CRM). The run skips those columns, syncs the rest, and reports the labels.
 */
export class CrmSchemaDriftError extends Data.TaggedError("CrmSchemaDriftError")<{
  readonly provider: string;
  readonly missingAttrs: ReadonlyArray<string>;
}> {}

/** The bound object/list itself is gone upstream (404 on the source). */
export class CrmSourceGoneError extends Data.TaggedError("CrmSourceGoneError")<{
  readonly provider: string;
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

/** The CRM rejected the request as malformed (400/403) — e.g. an inexpressible filter or a missing scope. */
export class CrmRequestError extends Data.TaggedError("CrmRequestError")<{
  readonly provider: string;
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
  | CrmRateLimitError
  | CrmServerError
  | CrmNetworkError
  | CrmAuthRevoked
  | CrmConnectionMissing
  | CrmSchemaDriftError
  | CrmSourceGoneError
  | RowCapReached
  | CrmRequestError
  | CrmSyncError;

/** Failures worth an in-process retry: rate limit, 5xx, or network. */
export const isTransientCrmError = (e: CrmError): boolean =>
  e._tag === "CrmRateLimitError" ||
  e._tag === "CrmServerError" ||
  e._tag === "CrmNetworkError";
