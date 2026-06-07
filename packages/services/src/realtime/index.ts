/**
 * `@gtmgrid/services/realtime` — the PURE, browser-safe realtime subpath.
 *
 * The package's main barrel (`@gtmgrid/services`) pulls in the Drizzle-backed
 * repositories and `@gtmgrid/db`, which must never reach the desktop's browser
 * bundle. This subpath re-exports ONLY the realtime client surface the desktop
 * grid needs — the pure event schema + reducer ({@link applyGridEvent}) and the
 * thin Supabase channel subscriber ({@link subscribeToGrid}) — so the desktop
 * imports `@gtmgrid/services/realtime` and never the db-heavy main entry.
 *
 * Identical exports to the realtime slice of the main barrel; kept in sync there.
 */

export {
  type CellUpsertEvent,
  type ColumnDeleteEvent,
  type ColumnInsertEvent,
  GRID_EVENT_NAME,
  type GridChangeEvent,
  type GridEventCell,
  type GridEventColumn,
  type GridEventRow,
  type GridSnapshot,
  gridChannelName,
  type RowDeleteEvent,
  type RowInsertEvent,
  type TableDeleteEvent,
  type TableInsertEvent,
} from "./events.js";
export { applyGridEvent } from "./reducer.js";
export {
  type GridPresenceState,
  type GridSubscription,
  subscribeToGrid,
  type SubscribeToGridOptions,
} from "./channel.js";
