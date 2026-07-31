// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

// posthog-js is a browser SDK; stub it so the tests assert the ORDER and shape
// of the calls consent.ts makes, which is the part that has repeatedly broken.
const posthogMock = vi.hoisted(() => ({
  set_config: vi.fn(),
  opt_in_capturing: vi.fn(),
  opt_out_capturing: vi.fn(),
  reset: vi.fn(),
  capture: vi.fn(),
}));

vi.mock("posthog-js", () => ({ default: posthogMock }));

const { CONSENT_STORAGE_KEY, applyConsent, openConsentSettings, readConsent, writeConsent } =
  await import("./consent");

/** Order of every posthog call made during a test, for sequence assertions. */
function callOrder(): string[] {
  return [
    ...posthogMock.set_config.mock.calls.map(() => "set_config"),
    ...posthogMock.opt_in_capturing.mock.calls.map(() => "opt_in"),
    ...posthogMock.opt_out_capturing.mock.calls.map(() => "opt_out"),
    ...posthogMock.reset.mock.calls.map(() => "reset"),
  ];
}

beforeEach(() => {
  window.localStorage.clear();
  vi.clearAllMocks();
});

describe("readConsent", () => {
  it("returns null when nothing has been chosen", () => {
    expect(readConsent()).toBeNull();
  });

  it("round-trips both choices", () => {
    writeConsent("granted");
    expect(readConsent()).toBe("granted");
    writeConsent("denied");
    expect(readConsent()).toBe("denied");
  });

  it("treats an unrecognised stored value as no choice", () => {
    window.localStorage.setItem(CONSENT_STORAGE_KEY, "maybe");
    expect(readConsent()).toBeNull();
  });

  it("treats an unreadable store as no choice rather than throwing", () => {
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError: localStorage is disabled");
    });
    expect(readConsent()).toBeNull();
    spy.mockRestore();
  });
});

describe("applyConsent — granted", () => {
  it("switches to persistent storage, opts in, and captures the consenting pageview", () => {
    applyConsent("granted");
    expect(posthogMock.set_config).toHaveBeenCalledWith({
      persistence: "localStorage+cookie",
    });
    expect(posthogMock.opt_in_capturing).toHaveBeenCalledTimes(1);
    // Without this the landing page that won the consent is never recorded:
    // posthog defers the initial $pageview and skips it while opted out.
    expect(posthogMock.capture).toHaveBeenCalledWith("$pageview");
  });

  it("never resets identity when granting", () => {
    applyConsent("granted");
    expect(posthogMock.reset).not.toHaveBeenCalled();
  });
});

describe("applyConsent — denied", () => {
  it("opts out and resets BEFORE dropping to memory persistence", () => {
    applyConsent("denied");
    // Order matters: opting out after a reset could capture during teardown,
    // and swapping persistence first would leave written state behind.
    expect(callOrder()).toEqual(["set_config", "opt_out", "reset"]);
    expect(posthogMock.set_config).toHaveBeenCalledWith({ persistence: "memory" });
  });

  it("does not opt in or capture a pageview", () => {
    applyConsent("denied");
    expect(posthogMock.opt_in_capturing).not.toHaveBeenCalled();
    expect(posthogMock.capture).not.toHaveBeenCalled();
  });
});

describe("writeConsent", () => {
  it("persists the choice and applies it", () => {
    writeConsent("granted");
    expect(window.localStorage.getItem(CONSENT_STORAGE_KEY)).toBe("granted");
    expect(posthogMock.opt_in_capturing).toHaveBeenCalledTimes(1);
  });

  it("still applies the choice when persistence fails", () => {
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(() => writeConsent("denied")).not.toThrow();
    expect(posthogMock.opt_out_capturing).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

describe("openConsentSettings", () => {
  it("re-opens the banner without touching the stored choice or PostHog", () => {
    writeConsent("granted");
    vi.clearAllMocks();

    const listener = vi.fn();
    window.addEventListener("gtmgrid:consent-reopen", listener);
    openConsentSettings();
    window.removeEventListener("gtmgrid:consent-reopen", listener);

    expect(listener).toHaveBeenCalledTimes(1);
    // Opening settings is not withdrawal — the regression this guards against.
    expect(readConsent()).toBe("granted");
    expect(posthogMock.opt_out_capturing).not.toHaveBeenCalled();
    expect(posthogMock.reset).not.toHaveBeenCalled();
  });
});
