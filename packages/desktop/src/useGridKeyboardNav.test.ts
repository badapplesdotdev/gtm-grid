// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useGridKeyboardNav, resolveEditTrigger } from "./useGridKeyboardNav";

/** Minimal React.KeyboardEvent stand-in for the handler under test. */
function keyEvent(key: string, mods: Partial<{ shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; altKey: boolean }> = {}) {
  return {
    key,
    shiftKey: false,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    ...mods,
    preventDefault: vi.fn(),
    target: { tagName: "TD", isContentEditable: false },
  } as unknown as React.KeyboardEvent<HTMLElement>;
}

const baseOpts = () => ({
  rowCount: 5,
  colCount: 3,
  rowHeight: 34,
  scrollRef: { current: null } as React.RefObject<HTMLDivElement | null>,
  scrollToIndex: vi.fn(),
});

function setup(extra: Record<string, unknown> = {}) {
  return renderHook(() => useGridKeyboardNav({ ...baseOpts(), ...extra } as Parameters<typeof useGridKeyboardNav>[0]));
}

describe("useGridKeyboardNav", () => {
  it("starts with no active cell and lands on (0,0) on first nav key", () => {
    const { result } = setup();
    expect(result.current.active).toBeNull();
    act(() => result.current.onKeyDown(keyEvent("ArrowDown")));
    expect(result.current.active).toEqual({ row: 0, col: 0 });
  });

  it("moves with arrow keys and clamps at edges", () => {
    const { result } = setup();
    act(() => result.current.onCellFocus(0, 0));
    act(() => result.current.onKeyDown(keyEvent("ArrowDown")));
    act(() => result.current.onKeyDown(keyEvent("ArrowRight")));
    expect(result.current.active).toEqual({ row: 1, col: 1 });
    // Clamp at top-left.
    act(() => result.current.onKeyDown(keyEvent("ArrowUp")));
    act(() => result.current.onKeyDown(keyEvent("ArrowUp")));
    act(() => result.current.onKeyDown(keyEvent("ArrowLeft")));
    act(() => result.current.onKeyDown(keyEvent("ArrowLeft")));
    expect(result.current.active).toEqual({ row: 0, col: 0 });
  });

  it("Home/End and Cmd+Arrow jump to row/grid edges", () => {
    const { result } = setup();
    act(() => result.current.onCellFocus(2, 1));
    act(() => result.current.onKeyDown(keyEvent("End")));
    expect(result.current.active).toEqual({ row: 2, col: 2 });
    act(() => result.current.onKeyDown(keyEvent("Home")));
    expect(result.current.active).toEqual({ row: 2, col: 0 });
    act(() => result.current.onKeyDown(keyEvent("ArrowDown", { metaKey: true })));
    expect(result.current.active).toEqual({ row: 4, col: 0 });
  });

  it("Enter requests an edit (bumps editSignal, no seed)", () => {
    const { result } = setup();
    act(() => result.current.onCellFocus(1, 1));
    expect(result.current.editSignal).toBe(0);
    act(() => result.current.onKeyDown(keyEvent("Enter")));
    expect(result.current.editSignal).toBe(1);
    expect(result.current.getEditSeed()).toBeUndefined();
  });

  it("typing a printable char requests edit seeded with that char", () => {
    const { result } = setup();
    act(() => result.current.onCellFocus(1, 1));
    act(() => result.current.onKeyDown(keyEvent("x")));
    expect(result.current.editSignal).toBe(1);
    expect(result.current.getEditSeed()).toBe("x");
  });

  it("Shift+Arrow extends selection to the entered row", () => {
    const onExtendSelection = vi.fn();
    const { result } = setup({ onExtendSelection });
    act(() => result.current.onCellFocus(0, 0));
    act(() => result.current.onKeyDown(keyEvent("ArrowDown", { shiftKey: true })));
    expect(onExtendSelection).toHaveBeenCalledWith(1);
  });

  it("Cmd+A selects all and Escape clears selection", () => {
    const onSelectAll = vi.fn();
    const onClearSelection = vi.fn();
    const { result } = setup({ onSelectAll, onClearSelection });
    act(() => result.current.onCellFocus(0, 0));
    act(() => result.current.onKeyDown(keyEvent("a", { metaKey: true })));
    expect(onSelectAll).toHaveBeenCalledTimes(1);
    act(() => result.current.onKeyDown(keyEvent("Escape")));
    expect(onClearSelection).toHaveBeenCalledTimes(1);
  });

  it("Space toggles selection of the active row", () => {
    const onToggleSelection = vi.fn();
    const { result } = setup({ onToggleSelection });
    act(() => result.current.onCellFocus(3, 2));
    act(() => result.current.onKeyDown(keyEvent(" ")));
    expect(onToggleSelection).toHaveBeenCalledWith(3);
  });

  it("ignores keys while focus is in an input (editing)", () => {
    const { result } = setup();
    act(() => result.current.onCellFocus(1, 1));
    const ev = keyEvent("ArrowDown");
    (ev as unknown as { target: { tagName: string } }).target = { tagName: "INPUT" };
    act(() => result.current.onKeyDown(ev));
    expect(result.current.active).toEqual({ row: 1, col: 1 });
  });
});

describe("resolveEditTrigger", () => {
  it("does NOT edit when a cell first becomes active (stale signal) — regression", () => {
    // Cell becomes active inheriting a non-zero signal from a prior cell's edit.
    // It must baseline, not reopen the editor. (Bug found in e2e.)
    expect(resolveEditTrigger({ isActive: true, wasActive: false, signal: 3, baseline: 0 }))
      .toEqual({ edit: false, baseline: 3 });
  });

  it("edits when the signal increments while already active", () => {
    expect(resolveEditTrigger({ isActive: true, wasActive: true, signal: 4, baseline: 3 }))
      .toEqual({ edit: true, baseline: 4 });
  });

  it("does not edit when active with an unchanged signal", () => {
    expect(resolveEditTrigger({ isActive: true, wasActive: true, signal: 3, baseline: 3 }))
      .toEqual({ edit: false, baseline: 3 });
  });

  it("does not edit when inactive (and preserves baseline)", () => {
    expect(resolveEditTrigger({ isActive: false, wasActive: true, signal: 5, baseline: 3 }))
      .toEqual({ edit: false, baseline: 3 });
  });
});
