// @vitest-environment jsdom
import { useRef } from "react";
import { render, act, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAdaptiveOverscan, type AdaptiveOverscanOptions } from "./useAdaptiveOverscan";

function Probe({ opts }: { opts: AdaptiveOverscanOptions }) {
  const ref = useRef<HTMLDivElement>(null);
  const overscan = useAdaptiveOverscan(ref, "y", opts);
  return (
    <div ref={ref} data-testid="scroller">
      <span data-testid="ov">{overscan}</span>
    </div>
  );
}

const OPTS: AdaptiveOverscanOptions = { idle: 8, fast: 100, thresholdPxPerMs: 1, idleMs: 120 };

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("useAdaptiveOverscan", () => {
  function scrollTo(el: HTMLElement, top: number, atMs: number, clock: { t: number }) {
    act(() => {
      clock.t = atMs;
      el.scrollTop = top;
      el.dispatchEvent(new Event("scroll"));
    });
  }

  it("widens to the fast buffer on a quick fling, then collapses after idle", () => {
    const clock = { t: 0 };
    vi.useFakeTimers(); // fakes setTimeout (idle collapse) AND performance.now…
    vi.spyOn(performance, "now").mockImplementation(() => clock.t); // …so re-own it.

    const { getByTestId } = render(<Probe opts={OPTS} />);
    const el = getByTestId("scroller");
    expect(getByTestId("ov").textContent).toBe("8"); // starts at idle

    scrollTo(el, 0, 0, clock); // baseline sample
    scrollTo(el, 240, 12, clock); // 240px / 12ms = 20 px/ms ≫ threshold → fast
    expect(getByTestId("ov").textContent).toBe("100");

    act(() => vi.advanceTimersByTime(130)); // > idleMs with no further scroll
    expect(getByTestId("ov").textContent).toBe("8"); // collapsed back to idle
  });

  it("stays at the idle buffer for a slow reading scroll", () => {
    const clock = { t: 0 };
    vi.useFakeTimers(); // fakes setTimeout (idle collapse) AND performance.now…
    vi.spyOn(performance, "now").mockImplementation(() => clock.t); // …so re-own it.

    const { getByTestId } = render(<Probe opts={OPTS} />);
    const el = getByTestId("scroller");

    scrollTo(el, 0, 0, clock);
    scrollTo(el, 6, 100, clock); // 6px / 100ms = 0.06 px/ms ≪ threshold → still idle
    expect(getByTestId("ov").textContent).toBe("8");
  });
});
