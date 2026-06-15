/**
 * useGridKeyboardNav — spreadsheet-style keyboard navigation for the shared
 * DataGrid. Lives beside DataGrid so BOTH the local (App.tsx) and cloud
 * (CloudGrid.tsx) environments get it for free.
 *
 * The grid is doubly virtualized (rows in VirtualGridBody, columns in
 * useColumnWindow), so a cell that scrolls out of view is UNMOUNTED from the
 * DOM. A roving-tabindex approach therefore can't rely on the focused element
 * surviving a scroll. Instead we track the active cell as {row,col} INDICES,
 * and on every move we:
 *   1. scroll the target into the virtual window (reusing DataGrid's scrollToCell), then
 *   2. poll for the now-mounted `[data-cell="r:c"]` node across a few frames and focus it.
 *
 * Editing is requested by bumping `editSignal`; DataGrid passes the signal only
 * to the ACTIVE cell (0 to all others), so CellContent's memoization is
 * preserved — only the active cell re-renders when an edit is requested.
 */

import { useCallback, useEffect, useRef, useState } from "react";

export type ActiveCell = { row: number; col: number };

export const cellDomId = (row: number, col: number): string => `${row}:${col}`;

type Options = {
  rowCount: number;
  colCount: number;
  rowHeight: number;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  /** Bring a cell into the virtual window (DataGrid's existing helper). */
  scrollToIndex: (row: number, col: number) => void;
  /** Extend the row selection to `row` (Shift+Arrow / Shift+Space). */
  onExtendSelection?: (row: number) => void;
  /** Toggle selection of a single row (Space). */
  onToggleSelection?: (row: number) => void;
  onSelectAll?: () => void;
  onClearSelection?: () => void;
};

const clamp = (n: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, n));

const isPrintable = (e: React.KeyboardEvent): boolean =>
  e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;

export function useGridKeyboardNav({
  rowCount,
  colCount,
  rowHeight,
  scrollRef,
  scrollToIndex,
  onExtendSelection,
  onToggleSelection,
  onSelectAll,
  onClearSelection,
}: Options) {
  const [active, setActive] = useState<ActiveCell | null>(null);
  // Bumped to request that the active cell enter edit mode; `editSeed` carries
  // the first typed character for type-to-edit (undefined = edit current value).
  const [editSignal, setEditSignal] = useState(0);
  const editSeedRef = useRef<string | undefined>(undefined);
  // Latch a focus request; an effect performs the scroll-then-focus so it runs
  // after the move re-renders the grid.
  const focusReq = useRef(0);
  const lastFocused = useRef(0);

  // Focus the active cell once it's mounted. Smooth-scroll first, then poll a
  // few animation frames for the (possibly just-remounted) node.
  useEffect(() => {
    if (active === null || focusReq.current === lastFocused.current) return;
    lastFocused.current = focusReq.current;
    scrollToIndex(active.row, active.col);
    const sel = `[data-cell="${cellDomId(active.row, active.col)}"]`;
    let frames = 0;
    let raf = 0;
    const tryFocus = () => {
      const node = scrollRef.current?.querySelector<HTMLElement>(sel);
      if (node) {
        // preventScroll: we already positioned the viewport via scrollToIndex;
        // letting focus re-scroll would fight the smooth scroll.
        node.focus({ preventScroll: true });
        return;
      }
      if (frames++ < 20) raf = requestAnimationFrame(tryFocus);
    };
    raf = requestAnimationFrame(tryFocus);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, focusReq.current]);

  const moveTo = useCallback(
    (row: number, col: number) => {
      const r = clamp(row, 0, Math.max(0, rowCount - 1));
      const cc = clamp(col, 0, Math.max(0, colCount - 1));
      setActive({ row: r, col: cc });
      focusReq.current++;
    },
    [rowCount, colCount],
  );

  const requestEdit = useCallback((seed?: string) => {
    editSeedRef.current = seed;
    setEditSignal((s) => s + 1);
  }, []);

  /** Sync the active cell when focus enters a cell by mouse/Tab. */
  const onCellFocus = useCallback((row: number, col: number) => {
    setActive((prev) =>
      prev && prev.row === row && prev.col === col ? prev : { row, col },
    );
  }, []);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLElement>) => {
      // Ignore keys while editing inside an input/textarea within the grid.
      const target = e.target as HTMLElement;
      if (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable
      ) {
        return;
      }
      if (rowCount === 0 || colCount === 0) return;
      const cur: ActiveCell = active ?? { row: 0, col: 0 };
      const pageRows = Math.max(
        1,
        Math.floor((scrollRef.current?.clientHeight ?? rowHeight * 10) / rowHeight) - 1,
      );
      const mod = e.metaKey || e.ctrlKey;

      switch (e.key) {
        case "ArrowUp":
          e.preventDefault();
          if (e.shiftKey) onExtendSelection?.(clamp(cur.row - 1, 0, rowCount - 1));
          moveTo(mod ? 0 : cur.row - 1, cur.col);
          break;
        case "ArrowDown":
          e.preventDefault();
          if (e.shiftKey) onExtendSelection?.(clamp(cur.row + 1, 0, rowCount - 1));
          moveTo(mod ? rowCount - 1 : cur.row + 1, cur.col);
          break;
        case "ArrowLeft":
          e.preventDefault();
          moveTo(cur.row, mod ? 0 : cur.col - 1);
          break;
        case "ArrowRight":
          e.preventDefault();
          moveTo(cur.row, mod ? colCount - 1 : cur.col + 1);
          break;
        case "Home":
          e.preventDefault();
          moveTo(mod ? 0 : cur.row, 0);
          break;
        case "End":
          e.preventDefault();
          moveTo(mod ? rowCount - 1 : cur.row, colCount - 1);
          break;
        case "PageUp":
          e.preventDefault();
          moveTo(cur.row - pageRows, cur.col);
          break;
        case "PageDown":
          e.preventDefault();
          moveTo(cur.row + pageRows, cur.col);
          break;
        case "Enter":
        case "F2":
          e.preventDefault();
          if (!active) moveTo(0, 0);
          else requestEdit(undefined);
          break;
        case " ":
          // Space toggles row selection (spreadsheet convention); don't scroll.
          e.preventDefault();
          onToggleSelection?.(cur.row);
          break;
        case "Escape":
          onClearSelection?.();
          break;
        case "a":
        case "A":
          if (mod) {
            e.preventDefault();
            onSelectAll?.();
          }
          break;
        default:
          if (isPrintable(e)) {
            e.preventDefault();
            if (!active) moveTo(0, 0);
            requestEdit(e.key);
          }
      }
    },
    [
      active,
      rowCount,
      colCount,
      rowHeight,
      scrollRef,
      moveTo,
      requestEdit,
      onExtendSelection,
      onToggleSelection,
      onSelectAll,
      onClearSelection,
    ],
  );

  return {
    active,
    setActive,
    onCellFocus,
    onKeyDown,
    editSignal,
    /** Read the seed for the current edit request (consumed by the active cell). */
    getEditSeed: () => editSeedRef.current,
  };
}
