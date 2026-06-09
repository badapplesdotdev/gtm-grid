// Abort-lifecycle helper for the agent panel (TRI-3305).
//
// The panel is conditionally/lazily mounted, so closing it UNMOUNTS the
// component. Without cleanup, the in-flight `/api/agent/chat` fetch keeps
// streaming and the server keeps the spawned CLI (+ its MCP server tree) alive,
// leaking memory. We abort the controller on unmount AND whenever the active
// agent / table / cloud context changes (a turn started against one context must
// not keep running once the user has switched away).
//
// Extracted as a pure unit so it is testable without a full React harness: the
// panel calls `abortInFlight(abortRef)` from a `useEffect` cleanup.

/** A minimal ref shape so the helper is agnostic of React's RefObject typing. */
export interface AbortRef {
  current: AbortController | null;
}

/**
 * Abort the in-flight request if one is active, then clear the ref so a later
 * cleanup (e.g. the unmount after a context-change) can't abort a stale or
 * already-aborted controller. Safe to call repeatedly.
 */
export function abortInFlight(ref: AbortRef): void {
  const controller = ref.current;
  if (!controller) return;
  ref.current = null;
  controller.abort();
}
