/**
 * Failure classification for the Google Picker page.
 *
 * Split out of `page.tsx` so the retry POLICY is testable without mounting a
 * React tree. It is the non-obvious half of moving this page onto React Query:
 * the fetching is mechanical, but the default retry behaviour is actively wrong
 * here, and nothing about the page's appearance would reveal a regression.
 */

/**
 * A failure with the server's reason attached.
 *
 * `code === null` means the request never got an answer (network, DNS, a dead
 * tunnel, a failed script load). That is the ONLY retryable case — see
 * {@link isRetryable}.
 */
export class PickerError extends Error {
  constructor(readonly code: string | null) {
    super(code ?? "transport");
    this.name = "PickerError";
  }
}

/** Max attempts AFTER the first, for transport failures only. */
export const MAX_RETRIES = 2;

/**
 * Retry TRANSPORT failures only.
 *
 * React Query's default is three retries with backoff, on everything. Applied to
 * this endpoint that means an expired `state`, a revoked connection, or a
 * deployment missing its Picker keys each spin for several seconds before
 * showing a message that was correct and final on the FIRST attempt — which
 * reads as a hang, and invites the user to reload into an identical failure.
 *
 * Note this keys on the server's error CODE, not on the HTTP status: a 500
 * carrying `picker_not_configured` is a permanent operator misconfiguration, and
 * a status-based rule ("retry 5xx") would hammer it three times over.
 */
export const isRetryable = (failureCount: number, error: unknown): boolean =>
  failureCount < MAX_RETRIES && error instanceof PickerError && error.code === null;

/** Read the server's `{ error }` code off a response body, if it named one. */
export const errorCode = (raw: unknown): string | null => {
  const code = typeof raw === "object" && raw !== null ? Reflect.get(raw, "error") : undefined;
  return typeof code === "string" ? code : null;
};

/**
 * Human copy for the API's error codes.
 *
 * The raw codes leak the trust model ("invalid_or_expired_state" tells a user
 * nothing and an attacker something), and every one of these is recoverable by a
 * different action — so they get different sentences, not one generic apology.
 */
export const errorCopy = (error: unknown): string => {
  const code = error instanceof PickerError ? error.code : null;
  switch (code) {
    case "invalid_or_expired_state":
      return "This link has expired. Close this tab and choose “Select spreadsheets” again from GTM Grid.";
    case "not_connected":
      return "This workspace is not connected to Google any more. Reconnect from GTM Grid, then try again.";
    case "picker_not_configured":
      return "Google Picker is not set up on this deployment. An administrator needs to set GOOGLE_PICKER_API_KEY and GOOGLE_PICKER_APP_ID.";
    case "no_valid_files":
      return "Those files couldn’t be read. Try selecting them again.";
    default:
      return "Something went wrong loading the Google file picker. Close this tab and try again.";
  }
};
