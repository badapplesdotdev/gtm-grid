import type { Cell, Column, FullTable, Row } from "./api";

export type FilterOperator =
  | "equals"
  | "not_equals"
  | "contains"
  | "not_contains"
  | "contains_any"
  | "greater_than"
  | "greater_than_or_equal"
  | "less_than"
  | "less_than_or_equal"
  | "before"
  | "after"
  | "is_empty"
  | "is_not_empty"
  | "has_error"
  | "has_no_error"
  | "has_results"
  | "has_no_results"
  | "has_not_run"
  | "is_queued"
  | "is_running"
  | "is_not_running";

export interface GridFilterRule {
  readonly id: string;
  readonly columnId: string;
  readonly operator: FilterOperator;
  readonly value: string;
}

export interface GridFilterGroup {
  readonly id: string;
  readonly mode: "all" | "any";
  readonly rules: readonly GridFilterRule[];
}

export interface GridViewState {
  readonly hiddenColumnIds: readonly string[];
  readonly pinnedColumnIds: readonly string[];
  readonly filterGroups: readonly GridFilterGroup[];
}

export const EMPTY_GRID_VIEW: GridViewState = {
  hiddenColumnIds: [],
  pinnedColumnIds: [],
  filterGroups: [],
};

export const VALUELESS_OPERATORS = new Set<FilterOperator>([
  "is_empty",
  "is_not_empty",
  "has_error",
  "has_no_error",
  "has_results",
  "has_no_results",
  "has_not_run",
  "is_queued",
  "is_running",
  "is_not_running",
]);

export function isFilterRuleComplete(rule: GridFilterRule): boolean {
  return VALUELESS_OPERATORS.has(rule.operator) || rule.value.trim().length > 0;
}

export interface FilterOperatorOption {
  readonly value: FilterOperator;
  readonly label: string;
}

const TEXT_OPERATORS: readonly FilterOperatorOption[] = [
  { value: "equals", label: "equal to" },
  { value: "not_equals", label: "not equal to" },
  { value: "contains", label: "contains" },
  { value: "contains_any", label: "contains any of" },
  { value: "not_contains", label: "does not contain" },
  { value: "is_empty", label: "is empty" },
  { value: "is_not_empty", label: "is not empty" },
];

const NUMBER_OPERATORS: readonly FilterOperatorOption[] = [
  { value: "equals", label: "equal to" },
  { value: "not_equals", label: "not equal to" },
  { value: "greater_than", label: "greater than" },
  { value: "greater_than_or_equal", label: "greater than or equal to" },
  { value: "less_than", label: "less than" },
  { value: "less_than_or_equal", label: "less than or equal to" },
  { value: "is_empty", label: "is empty" },
  { value: "is_not_empty", label: "is not empty" },
];

const DATE_OPERATORS: readonly FilterOperatorOption[] = [
  { value: "equals", label: "on" },
  { value: "before", label: "before" },
  { value: "after", label: "after" },
  { value: "is_empty", label: "is empty" },
  { value: "is_not_empty", label: "is not empty" },
];

const FUNCTION_OPERATORS: readonly FilterOperatorOption[] = [
  { value: "has_error", label: "has an error" },
  { value: "has_no_error", label: "does not contain an error" },
  { value: "has_results", label: "has results" },
  { value: "has_no_results", label: "has no results" },
  { value: "has_not_run", label: "has not run" },
  { value: "is_queued", label: "is queued" },
  { value: "is_running", label: "is running" },
  { value: "is_not_running", label: "is not running" },
  ...TEXT_OPERATORS,
];

export function filterOperatorsForColumn(column: Column): readonly FilterOperatorOption[] {
  if (column.kind === "function") return FUNCTION_OPERATORS;
  const type = column.type.toLowerCase();
  if (type.includes("date") || type.includes("time")) return DATE_OPERATORS;
  if (type.includes("number") || type.includes("currency") || type.includes("percent")) return NUMBER_OPERATORS;
  return TEXT_OPERATORS;
}

export function defaultOperatorForColumn(column: Column): FilterOperator {
  return filterOperatorsForColumn(column)[0].value;
}

function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || value === "" ||
    (Array.isArray(value) && value.length === 0);
}

function comparable(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    try { return JSON.stringify(value); } catch { return String(value); }
  }
  return String(value);
}

function dateOnly(value: unknown): number | null {
  const source = comparable(value);
  const plain = /^(\d{4})-(\d{2})-(\d{2})$/.exec(source);
  if (plain) return Date.UTC(Number(plain[1]), Number(plain[2]) - 1, Number(plain[3]));
  const date = new Date(source);
  if (Number.isNaN(date.getTime())) return null;
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

export function matchesFilterRule(row: Row, rule: GridFilterRule): boolean {
  const cell: Cell | undefined = row.cells[rule.columnId];
  const value = cell?.value;
  const actual = comparable(value).toLocaleLowerCase();
  const expected = rule.value.trim().toLocaleLowerCase();

  switch (rule.operator) {
    case "is_empty": return isEmpty(value);
    case "is_not_empty": return !isEmpty(value);
    case "equals": {
      if (/^\d{4}-\d{2}-\d{2}$/.test(expected)) {
        const a = dateOnly(value); const b = dateOnly(rule.value);
        if (a !== null && b !== null) return a === b;
      }
      return actual === expected;
    }
    case "not_equals": return actual !== expected;
    case "contains": return actual.includes(expected);
    case "not_contains": return !actual.includes(expected);
    case "contains_any":
      return rule.value.split(",").map((v) => v.trim().toLocaleLowerCase()).filter(Boolean)
        .some((candidate) => actual.includes(candidate));
    case "greater_than": return Number(value) > Number(rule.value);
    case "greater_than_or_equal": return Number(value) >= Number(rule.value);
    case "less_than": return Number(value) < Number(rule.value);
    case "less_than_or_equal": return Number(value) <= Number(rule.value);
    case "before": {
      const a = dateOnly(value); const b = dateOnly(rule.value);
      return a !== null && b !== null && a < b;
    }
    case "after": {
      const a = dateOnly(value); const b = dateOnly(rule.value);
      return a !== null && b !== null && a > b;
    }
    case "has_error": return cell?.status === "error" || !!cell?.error;
    case "has_no_error": return cell?.status !== "error" && !cell?.error;
    case "has_results": return cell?.status === "done" && !isEmpty(value);
    case "has_no_results": return cell?.status === "done" && isEmpty(value);
    case "has_not_run": return !cell || cell.status === "empty";
    case "is_queued": return cell?.status === "pending";
    case "is_running": return cell?.status === "running";
    case "is_not_running": return cell?.status !== "running";
  }
}

export function matchesFilterGroups(row: Row, groups: readonly GridFilterGroup[]): boolean {
  return groups.every((group) => {
    const rules = group.rules.filter(isFilterRuleComplete);
    if (rules.length === 0) return true;
    return group.mode === "any"
      ? rules.some((rule) => matchesFilterRule(row, rule))
      : rules.every((rule) => matchesFilterRule(row, rule));
  });
}

/** Apply a non-destructive per-user view over the underlying table snapshot. */
export function applyGridView(table: FullTable, view: GridViewState): FullTable {
  const known = new Set(table.columns.map((column) => column.id));
  const hidden = new Set(view.hiddenColumnIds.filter((id) => known.has(id)));
  const pinned = new Set(view.pinnedColumnIds.filter((id) => known.has(id) && !hidden.has(id)));
  const visible = table.columns.filter((column) => !hidden.has(column.id));
  const columns = [
    ...visible.filter((column) => pinned.has(column.id)),
    ...visible.filter((column) => !pinned.has(column.id)),
  ];
  const rules = view.filterGroups.flatMap((group) => group.rules).filter((rule) => known.has(rule.columnId));
  const groups = view.filterGroups
    .map((group) => ({ ...group, rules: rules.filter((rule) => group.rules.some((candidate) => candidate.id === rule.id)) }))
    .filter((group) => group.rules.length > 0);
  const rows = groups.length ? table.rows.filter((row) => matchesFilterGroups(row, groups)) : table.rows;
  return { ...table, columns, rows };
}

export function sanitizeGridView(value: unknown, table: FullTable): GridViewState {
  if (!value || typeof value !== "object") return EMPTY_GRID_VIEW;
  const raw = value as Partial<GridViewState>;
  const ids = new Set(table.columns.map((column) => column.id));
  const strings = (input: unknown) => Array.isArray(input)
    ? input.filter((item): item is string => typeof item === "string" && ids.has(item))
    : [];
  const filterGroups = Array.isArray(raw.filterGroups)
    ? raw.filterGroups.flatMap((group): GridFilterGroup[] => {
        if (!group || typeof group !== "object") return [];
        const candidate = group as Partial<GridFilterGroup>;
        if (!Array.isArray(candidate.rules)) return [];
        const rules = candidate.rules.filter((rule): rule is GridFilterRule =>
          !!rule && typeof rule === "object" && typeof rule.id === "string" &&
          typeof rule.columnId === "string" && ids.has(rule.columnId) &&
          typeof rule.operator === "string" && typeof rule.value === "string");
        return rules.length ? [{ id: typeof candidate.id === "string" ? candidate.id : crypto.randomUUID(), mode: candidate.mode === "any" ? "any" : "all", rules }] : [];
      })
    : [];
  return {
    hiddenColumnIds: strings(raw.hiddenColumnIds),
    pinnedColumnIds: strings(raw.pinnedColumnIds),
    filterGroups,
  };
}
