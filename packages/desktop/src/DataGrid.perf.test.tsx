// @vitest-environment jsdom
/**
 * Render-performance guarantees for the shared grid (TRI render-perf).
 *
 * Three things are asserted, each guarding a property that fixes the reported
 * scroll/hover jank:
 *
 *  1. VIRTUALIZATION — a 5,000 × 50 table mounts only the windowed slice of rows
 *     and columns, never all of them (both axes are virtualized).
 *  2. UPDATE ISOLATION — a single cell change re-renders exactly ONE cell, not
 *     the whole viewport (the GridRow/GridCell memo boundaries + stable bundles).
 *  3. STABLE-PROP SKIP — re-rendering the grid with referentially-stable inputs
 *     re-renders ZERO cells (the controller decoupling / memo seams hold).
 *
 * `./App` is mocked so the test mounts the grid WITHOUT pulling the whole desktop
 * app tree: `Icon` becomes a no-op proxy and `CellContent` becomes a spy that
 * both renders the cell value AND records every render — so the spy's call count
 * is exactly the number of GridCells React actually rendered.
 */

import { createElement } from "react";
import { fireEvent, render, cleanup, act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// Records one entry per GridCell render (the spy is NOT memoized, so it renders
// iff its enclosing GridCell renders). Identifies the cell by column + value.
const cellRenderLog: string[] = [];

vi.mock("./App", () => ({
  // Any `Icon.Whatever` access returns a no-op component.
  Icon: new Proxy(
    {},
    { get: () => () => null },
  ),
  CellContent: (props: { col: { id: string }; cell?: { value: unknown } }) => {
    cellRenderLog.push(`${props.col.id}:${String(props.cell?.value ?? "")}`);
    return createElement("span", { className: "cell-value" }, String(props.cell?.value ?? ""));
  },
}));

// Deterministic virtualization: report a FIXED window (first 20 rows / 8 cols)
// regardless of jsdom's (absent) layout geometry. This is what lets the tests
// assert the grid mounts ONLY `getVirtualItems()` — i.e. that it windows both
// axes — without depending on real measurement. The production code uses the
// real react-virtual; only the tests substitute this stub.
const ROW_WINDOW = 20;
const COL_WINDOW = 8;
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (opts: { count: number; horizontal?: boolean }) => {
    const size = opts.horizontal ? 180 : 34;
    const n = Math.min(opts.count, opts.horizontal ? COL_WINDOW : ROW_WINDOW);
    const items = Array.from({ length: n }, (_, i) => ({
      index: i,
      start: i * size,
      end: (i + 1) * size,
      size,
      key: i,
    }));
    return {
      getVirtualItems: () => items,
      getTotalSize: () => opts.count * size,
      measureElement: () => {},
      scrollToIndex: () => {},
      options: opts,
    };
  },
}));

// Imported AFTER the mock so DataGrid/GridCell pick up the stubbed `./App`.
const { DataGrid } = await import("./DataGrid");
const { GridRow } = await import("./GridRow");
const { useState, useCallback, useMemo, useRef } = await import("react");
type GridController = import("./DataGrid").GridController;
type FullTable = import("./api").FullTable;
type Column = import("./api").Column;
type Row = import("./api").Row;

afterEach(() => {
  cleanup();
  cellRenderLog.length = 0;
});

function makeTable(nRows: number, nCols: number): FullTable {
  const columns: Column[] = Array.from({ length: nCols }, (_, c) => ({
    id: `c${c}`,
    name: `Col ${c}`,
    type: "text",
    kind: "manual",
    provider: null,
    method: null,
    fn: null,
    params: {},
  }));
  const rows: Row[] = Array.from({ length: nRows }, (_, r) => {
    const cells: Record<string, { value: unknown; status: "done"; error: null }> = {};
    for (let c = 0; c < nCols; c++) cells[`c${c}`] = { value: `r${r}c${c}`, status: "done", error: null };
    return { id: `r${r}`, cells };
  });
  return { id: "t1", name: "Heavy", columns, rows };
}

/** A minimal controller; all callbacks are no-ops (these tests only render). */
function makeController(table: FullTable, overrides: Partial<GridController> = {}): GridController {
  const noop = () => {};
  return {
    table,
    rowHeight: 34,
    columnWidth: () => 180,
    minColWidth: 80,
    runProgress: null,
    runningColId: null,
    runningCells: new Set<string>(),
    fnColCount: 0,
    canRun: true,
    canAddRow: true,
    addRow: noop,
    runAll: noop,
    runRows: noop,
    runColumn: noop,
    runCell: noop,
    setCell: noop,
    deleteRow: noop,
    deleteColumn: noop,
    clearCell: noop,
    editColumn: noop,
    openAddColumn: noop,
    ...overrides,
  };
}

describe("DataGrid virtualization", () => {
  it("mounts only the windowed slice of a 5,000 × 50 table (both axes)", () => {
    const table = makeTable(5000, 50);
    const { container } = render(createElement(DataGrid, { controller: makeController(table) }));

    // Body rows live in <tbody>; the sticky header <tr> is in <thead> and the
    // spacer rows carry no role — so this counts only mounted data rows. Exactly
    // the windowed slice is mounted — NOT all 5,000 rows (vertical virtualization).
    const bodyRows = container.querySelectorAll('tbody tr[role="row"]');
    expect(bodyRows.length).toBe(ROW_WINDOW);
    expect(bodyRows.length).toBeLessThan(5000);

    // And NOT all 50 columns per row (horizontal virtualization).
    const cells = bodyRows[0].querySelectorAll('td[role="gridcell"]');
    expect(cells.length).toBe(COL_WINDOW);
    expect(cells.length).toBeLessThan(50);
  });
});

/**
 * Harness that mimics a WS1-stabilized CloudGrid: every controller callback is
 * referentially stable and only `table` changes, so the memo seams can do their
 * job. Exposes two buttons — one mutates a single cell, one bumps an unrelated
 * counter (forcing a parent re-render with an unchanged controller shape).
 */
function Harness({ initial }: { initial: FullTable }) {
  const [table, setTable] = useState(initial);
  const [, setTick] = useState(0);
  const runningCells = useRef(new Set<string>()).current;
  const noop = useCallback(() => {}, []);
  const controller = useMemo<GridController>(
    () => makeController(table, { runningCells, addRow: noop, runAll: noop, runRows: noop, runColumn: noop, runCell: noop, setCell: noop, deleteRow: noop, deleteColumn: noop, clearCell: noop, editColumn: noop, openAddColumn: noop }),
    // Only `table` drives a new controller; the callbacks/sets are stable.
    [table, runningCells, noop],
  );
  return (
    <>
      <button
        data-testid="mutate"
        onClick={() =>
          setTable((t) => {
            const rows = t.rows.slice();
            const r0 = rows[0];
            // Preserve every other row's identity (what the real projector does);
            // rebuild only row 0 with a new cell for c0.
            rows[0] = { ...r0, cells: { ...r0.cells, c0: { value: "CHANGED", status: "done", error: null } } };
            return { ...t, columns: t.columns, rows };
          })
        }
      >
        mutate
      </button>
      <button data-testid="bump" onClick={() => setTick((n) => n + 1)}>
        bump
      </button>
      <DataGrid controller={controller} />
    </>
  );
}

describe("DataGrid memoization", () => {
  it("re-renders exactly one cell when a single cell changes", () => {
    const { getByTestId } = render(createElement(Harness, { initial: makeTable(100, 10) }));

    // Ignore the (many) initial-mount renders; measure only the update.
    cellRenderLog.length = 0;
    act(() => {
      fireEvent.click(getByTestId("mutate"));
    });

    expect(cellRenderLog).toEqual(["c0:CHANGED"]);
  });

  it("re-renders zero cells when the grid re-renders with stable inputs", () => {
    const { getByTestId } = render(createElement(Harness, { initial: makeTable(100, 10) }));

    cellRenderLog.length = 0;
    act(() => {
      fireEvent.click(getByTestId("bump")); // parent re-renders, controller shape unchanged
    });

    expect(cellRenderLog).toEqual([]);
  });
});

describe("GridRow comparator", () => {
  // React.memo(Component, areEqual) exposes the comparator as `.compare`.
  const compare = (GridRow as unknown as { compare: (a: unknown, b: unknown) => boolean }).compare;

  function baseProps() {
    return {
      actions: {},
      row: { id: "r0", cells: {} },
      rowIdx: 0,
      columns: [],
      columnWindow: { virtualColumns: [], spacers: { left: 0, right: 0 }, totalDataWidth: 0 },
      columnWindowKey: "0:5:6:0:0",
      selected: false,
      interaction: {},
      handlers: {},
    };
  }

  it("skips the row on a vertical scroll (fresh window object, same key)", () => {
    const a = baseProps();
    // A vertical scroll hands back a brand-new columnWindow object but an
    // UNCHANGED visible column range — the row must still skip.
    const b = { ...a, columnWindow: { ...a.columnWindow } };
    expect(compare(a, b)).toBe(true);
  });

  it("re-renders the row only when its own inputs change", () => {
    const a = baseProps();
    expect(compare(a, { ...a, row: { id: "r0", cells: {} } })).toBe(false); // new row obj (a cell update)
    expect(compare(a, { ...a, columnWindowKey: "1:6:6:180:0" })).toBe(false); // horizontal scroll
    expect(compare(a, { ...a, selected: true })).toBe(false);
    expect(compare(a, { ...a, interaction: {} })).toBe(false);
    expect(compare(a, { ...a, handlers: {} })).toBe(false);
    expect(compare(a, { ...a, actions: {} })).toBe(false);
  });
});
