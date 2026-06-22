/**
 * `@gtmgrid/services/columns` — shared column dependency analysis + dependency-
 * ordered execution, used by the desktop grid cascade and the server enrichers.
 */
export {
  type MinimalColumn,
  isFreeColumn,
  columnDependsOn,
  directDependencyIds,
  columnInCycle,
  stableTopoOrder,
  buildColumnDeps,
  transitiveDependents,
  topoSortColumnIds,
  runColumnsWithDeps,
} from "./deps.js";
