// @vitest-environment jsdom
/**
 * `useElementWidth` — tracks a ref'd element's width via ResizeObserver. jsdom has
 * no real layout or ResizeObserver, so we install a controllable mock and assert
 * the hook (a) seeds from getBoundingClientRect and (b) updates on observer ticks.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useRef } from "react";
import { useElementWidth } from "./useElementWidth";

// A controllable ResizeObserver mock: capture the callback so a test can fire it.
let fireResize: ((width: number) => void) | null = null;
class MockResizeObserver {
  constructor(private cb: ResizeObserverCallback) {
    fireResize = (width: number) =>
      this.cb(
        [{ contentRect: { width } } as ResizeObserverEntry],
        this as unknown as ResizeObserver,
      );
  }
  observe() {}
  disconnect() {}
  unobserve() {}
}

function Probe({ onWidth }: { onWidth: (w: number | null) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  onWidth(useElementWidth(ref));
  return <div ref={ref} />;
}

afterEach(() => {
  cleanup();
  fireResize = null;
  vi.restoreAllMocks();
});

describe("useElementWidth", () => {
  it("seeds the width from getBoundingClientRect on mount", () => {
    vi.stubGlobal("ResizeObserver", MockResizeObserver);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      width: 640,
    } as DOMRect);

    let latest: number | null = -1;
    render(<Probe onWidth={(w) => (latest = w)} />);
    expect(latest).toBe(640);
  });

  it("updates when the ResizeObserver reports a new width", () => {
    vi.stubGlobal("ResizeObserver", MockResizeObserver);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      width: 1000,
    } as DOMRect);

    let latest: number | null = -1;
    render(<Probe onWidth={(w) => (latest = w)} />);
    expect(latest).toBe(1000);

    act(() => fireResize?.(480));
    expect(latest).toBe(480);
  });
});
