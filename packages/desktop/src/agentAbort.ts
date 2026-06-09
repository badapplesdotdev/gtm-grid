// Abort-lifecycle helper for the agent panel (TRI-3305).
//
// The panel is conditionally/lazily mounted, so closing it UNMOUNTS the
// component. Without cleanup, the in-flight `/api/agent/chat` fetch keeps
// streaming and the server keeps the spawned CLI (+ its MCP server tree) alive,
// leaking memory. We abort the controller on unmount AND whenever the active
// agent / table context changes (a turn started against one context must not
// keep running once the user has switched away).
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

// The active-table context the panel's abort effect cares about. Passed from
// App.tsx as an inline object literal, so the OBJECT identity changes on every
// App re-render even when the underlying table is unchanged.
export interface ActiveTableContext {
  name: string;
  columns: string[];
}

/**
 * Derive the STABLE key that decides whether a context change should abort the
 * in-flight agent turn (TRI-3306).
 *
 * The panel's cleanup effect must fire on a true agent switch or table switch,
 * but NOT on unrelated App re-renders. TRI-3305 keyed the effect on the
 * `activeTable`/`cloud` OBJECT identities; because `activeTable` is an inline
 * literal, its identity churned every render (react-query cloud polling, etc.)
 * and the cleanup aborted the live turn mid-stream. Keying on the agent id plus
 * the table NAME (scalars) means the key only changes when the user actually
 * switches agent or table, so a new object identity for the same table is a
 * no-op. The cloud project is reflected in the table name, so switching cloud
 * projects (a different table) still produces a new key.
 */
export function agentAbortKey(agent: string, activeTable: ActiveTableContext | null): string {
  // JSON-encode the parts so the agent id and table name can never collide
  // across the boundary, and an empty table name stays distinct from a null
  // (local) table.
  return JSON.stringify([agent, activeTable?.name ?? null]);
}
