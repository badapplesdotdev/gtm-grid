import { useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { Column } from "./api";
import {
  VALUELESS_OPERATORS,
  defaultOperatorForColumn,
  filterOperatorsForColumn,
  type GridFilterGroup,
  type GridFilterRule,
  type GridViewState,
} from "./gridView";

type ViewSetter = Dispatch<SetStateAction<GridViewState>>;

function Glyph({ name }: { name: "columns" | "filter" | "search" | "eye" | "eyeOff" | "pin" | "x" }) {
  const common = { width: 14, height: 14, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  if (name === "columns") return <svg {...common}><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16M15 4v16"/></svg>;
  if (name === "filter") return <svg {...common}><path d="M4 5h16l-6.5 7.2V19l-3 1v-7.8z"/></svg>;
  if (name === "search") return <svg {...common}><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg>;
  if (name === "eye") return <svg {...common}><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="2.5"/></svg>;
  if (name === "eyeOff") return <svg {...common}><path d="m3 3 18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.9 5.2A11 11 0 0 1 12 5c6.5 0 10 7 10 7a18 18 0 0 1-2 2.8M6.6 6.6C3.6 8.4 2 12 2 12s3.5 7 10 7a10 10 0 0 0 4-.8"/></svg>;
  if (name === "pin") return <svg {...common}><path d="m14 4 6 6-3 1-4 4-1 5-2-6-6-6 5-1 4-4z"/><path d="m4 20 5-5"/></svg>;
  if (name === "x") return <svg {...common}><path d="m6 6 12 12M18 6 6 18"/></svg>;
  return null;
}

function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function columnTypeLabel(column: Column): string {
  if (column.kind === "function") return "Function";
  const value = column.type.toLowerCase();
  if (value.includes("date") || value.includes("time")) return "Date";
  if (value.includes("number")) return "Number";
  if (value.includes("email")) return "Email";
  if (value.includes("url")) return "URL";
  return "Text";
}

interface GridViewControlsProps {
  readonly columns: readonly Column[];
  readonly view: GridViewState;
  readonly setView: ViewSetter;
  readonly totalRows: number;
  readonly visibleRows: number;
}

export function GridViewControls({ columns, view, setView, totalRows, visibleRows }: GridViewControlsProps) {
  const [panel, setPanel] = useState<"columns" | "filters" | null>(null);
  const [panelPos, setPanelPos] = useState({ left: 0, top: 0 });
  const [columnQuery, setColumnQuery] = useState("");
  const columnsButton = useRef<HTMLButtonElement>(null);
  const filtersButton = useRef<HTMLButtonElement>(null);
  const columnIds = new Set(columns.map((column) => column.id));
  const hidden = new Set(view.hiddenColumnIds.filter((id) => columnIds.has(id)));
  const pinned = new Set(view.pinnedColumnIds.filter((id) => columnIds.has(id)));
  const filterCount = view.filterGroups.reduce((count, group) => count + group.rules.length, 0);

  const open = (kind: "columns" | "filters") => {
    if (panel === kind) { setPanel(null); return; }
    const button = kind === "columns" ? columnsButton.current : filtersButton.current;
    const rect = button?.getBoundingClientRect();
    setPanelPos({ left: Math.max(12, Math.min(rect?.left ?? 12, window.innerWidth - (kind === "filters" ? 760 : 390))), top: (rect?.bottom ?? 48) + 7 });
    setPanel(kind);
  };

  const toggleHidden = (columnId: string) => setView((current) => {
    const isHidden = current.hiddenColumnIds.includes(columnId);
    return {
      ...current,
      hiddenColumnIds: isHidden ? current.hiddenColumnIds.filter((id) => id !== columnId) : [...current.hiddenColumnIds, columnId],
      pinnedColumnIds: isHidden ? current.pinnedColumnIds : current.pinnedColumnIds.filter((id) => id !== columnId),
    };
  });

  const togglePinned = (columnId: string) => setView((current) => ({
    ...current,
    hiddenColumnIds: current.hiddenColumnIds.filter((id) => id !== columnId),
    pinnedColumnIds: current.pinnedColumnIds.includes(columnId)
      ? current.pinnedColumnIds.filter((id) => id !== columnId)
      : [...current.pinnedColumnIds, columnId],
  }));

  const addGroup = () => setView((current) => ({
    ...current,
    filterGroups: [...current.filterGroups, { id: newId("group"), mode: "all", rules: [] }],
  }));

  const addRule = (groupId?: string) => setView((current) => {
    const column = columns[0];
    if (!column) return current;
    const rule: GridFilterRule = { id: newId("rule"), columnId: column.id, operator: defaultOperatorForColumn(column), value: "" };
    if (!groupId) {
      const first = current.filterGroups[0];
      if (!first) return { ...current, filterGroups: [{ id: newId("group"), mode: "all", rules: [rule] }] };
      groupId = first.id;
    }
    return { ...current, filterGroups: current.filterGroups.map((group) => group.id === groupId ? { ...group, rules: [...group.rules, rule] } : group) };
  });

  const updateGroup = (groupId: string, update: (group: GridFilterGroup) => GridFilterGroup) => setView((current) => ({
    ...current,
    filterGroups: current.filterGroups.map((group) => group.id === groupId ? update(group) : group),
  }));

  const updateRule = (groupId: string, ruleId: string, patch: Partial<GridFilterRule>) => updateGroup(groupId, (group) => ({
    ...group,
    rules: group.rules.map((rule) => rule.id === ruleId ? { ...rule, ...patch } : rule),
  }));

  const removeRule = (groupId: string, ruleId: string) => setView((current) => ({
    ...current,
    filterGroups: current.filterGroups
      .map((group) => group.id === groupId ? { ...group, rules: group.rules.filter((rule) => rule.id !== ruleId) } : group)
      .filter((group) => group.rules.length > 0),
  }));

  const searchedColumns = useMemo(() => {
    const query = columnQuery.trim().toLocaleLowerCase();
    return query ? columns.filter((column) => column.name.toLocaleLowerCase().includes(query)) : columns;
  }, [columns, columnQuery]);

  return (
    <>
      <button ref={columnsButton} className={`grid-view-trigger${panel === "columns" ? " active" : ""}`} onClick={() => open("columns")} aria-expanded={panel === "columns"}>
        <Glyph name="columns" />
        <span>{columns.length - hidden.size}/{columns.length} columns</span>
      </button>
      <button ref={filtersButton} className={`grid-view-trigger${panel === "filters" || filterCount ? " active" : ""}`} onClick={() => open("filters")} aria-expanded={panel === "filters"}>
        <Glyph name="filter" />
        <span>Filter</span>
        {filterCount > 0 && <span className="grid-view-count">{filterCount}</span>}
      </button>

      {panel && <div className="grid-view-backdrop" onClick={() => setPanel(null)} />}
      {panel === "columns" && (
        <section className="grid-view-panel column-view-panel" style={panelPos} aria-label="Show, hide, and pin columns">
          <div className="grid-view-search"><Glyph name="search" /><input autoFocus value={columnQuery} onChange={(event) => setColumnQuery(event.target.value)} placeholder="Search columns" /></div>
          <div className="column-view-summary">
            <span>{columns.length - hidden.size} visible</span>
            {hidden.size > 0 && <button onClick={() => setView((current) => ({ ...current, hiddenColumnIds: [] }))}>Show all</button>}
          </div>
          <div className="column-view-list">
            {searchedColumns.map((column) => (
              <div
                className={`column-view-row${hidden.has(column.id) ? " is-hidden" : ""}`}
                data-column-visibility={hidden.has(column.id) ? "hidden" : "visible"}
                key={column.id}
              >
                <button
                  className="column-visibility-btn"
                  aria-label={hidden.has(column.id) ? `Show ${column.name}` : `Hide ${column.name}`}
                  aria-pressed={hidden.has(column.id)}
                  onClick={() => toggleHidden(column.id)}
                  title={hidden.has(column.id) ? `Show ${column.name}` : `Hide ${column.name}`}
                >
                  <Glyph name={hidden.has(column.id) ? "eyeOff" : "eye"} />
                </button>
                <span className="column-type-pill">{column.kind === "function" ? "ƒ" : columnTypeLabel(column).slice(0, 1)}</span>
                <span className="column-view-name">{column.name}</span>
                <span className={`column-view-type${hidden.has(column.id) ? " is-hidden" : ""}`}>
                  {hidden.has(column.id) ? "Hidden" : columnTypeLabel(column)}
                </span>
                <button className={`column-pin-btn${pinned.has(column.id) ? " pinned" : ""}`} disabled={hidden.has(column.id)} onClick={() => togglePinned(column.id)} title={pinned.has(column.id) ? `Unpin ${column.name}` : `Pin ${column.name}`}>
                  <Glyph name="pin" />
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {panel === "filters" && (
        <section className="grid-view-panel filter-view-panel" style={panelPos} aria-label="Filter rows">
          <header className="filter-view-header">
            <div><strong>Filters</strong><span>{visibleRows} of {totalRows} rows</span></div>
            {filterCount > 0 && <button className="filter-clear" onClick={() => setView((current) => ({ ...current, filterGroups: [] }))}>Clear filters</button>}
          </header>
          <div className="filter-groups">
            {view.filterGroups.map((group, groupIndex) => (
              <div className="filter-group" key={group.id}>
                {groupIndex > 0 && <div className="filter-group-join"><span>AND</span></div>}
                <div className="filter-group-top">
                  <span>Where</span>
                  {group.rules.length > 1 && (
                    <select value={group.mode} onChange={(event) => updateGroup(group.id, (current) => ({ ...current, mode: event.target.value as "all" | "any" }))}>
                      <option value="all">all are true</option><option value="any">any are true</option>
                    </select>
                  )}
                </div>
                {group.rules.map((rule) => {
                  const column = columns.find((candidate) => candidate.id === rule.columnId) ?? columns[0];
                  if (!column) return null;
                  const operators = filterOperatorsForColumn(column);
                  const valueType = column.type.toLowerCase().includes("date") || column.type.toLowerCase().includes("time") ? "date" : column.type.toLowerCase().includes("number") ? "number" : "text";
                  return (
                    <div className="filter-rule" key={rule.id}>
                      <select className="filter-column-select" value={rule.columnId} onChange={(event) => {
                        const next = columns.find((candidate) => candidate.id === event.target.value) ?? column;
                        updateRule(group.id, rule.id, { columnId: next.id, operator: defaultOperatorForColumn(next), value: "" });
                      }}>
                        {columns.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
                      </select>
                      <select className="filter-op-select" value={rule.operator} onChange={(event) => updateRule(group.id, rule.id, { operator: event.target.value as GridFilterRule["operator"] })}>
                        {operators.map((operator) => <option key={operator.value} value={operator.value}>{operator.label}</option>)}
                      </select>
                      {!VALUELESS_OPERATORS.has(rule.operator) && <input className="filter-value-input" type={valueType} value={rule.value} onChange={(event) => updateRule(group.id, rule.id, { value: event.target.value })} placeholder={rule.operator === "contains_any" ? "Comma-separated values" : "Enter a value"} />}
                      <button className="filter-remove" onClick={() => removeRule(group.id, rule.id)} title="Remove filter"><Glyph name="x" /></button>
                    </div>
                  );
                })}
                <button className="filter-add-inline" onClick={() => addRule(group.id)}>+ Add filter</button>
              </div>
            ))}
            {view.filterGroups.length === 0 && (
              <div className="filter-empty"><Glyph name="filter" /><strong>No filters applied</strong><span>Only rows matching your rules will stay visible.</span></div>
            )}
          </div>
          <footer className="filter-view-footer">
            <button onClick={() => addRule()}>+ Add filter</button>
            <button onClick={addGroup}>+ Add filter group</button>
          </footer>
        </section>
      )}
    </>
  );
}
