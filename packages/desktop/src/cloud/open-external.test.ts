// @vitest-environment jsdom
/**
 * openExternalUrl — the three hosts this runs in.
 *
 * Worth testing despite being a shim: it is the hand-off that STARTS every OAuth
 * flow. If it silently no-ops, "Connect Slack" does nothing at all, the card
 * sits on "Waiting for Slack…" for two minutes, and there is no error anywhere.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { openExternalUrl } from "./open-external";

const electron = vi.hoisted(() => vi.fn());
vi.mock("../electron", () => ({ electron }));

const URL_ = "https://slack.com/oauth/v2/authorize?state=abc";

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("packaged Electron", () => {
  it("uses the preload's openExternal IPC (a real system browser)", async () => {
    const openExternal = vi.fn(async () => {});
    electron.mockReturnValue({ openExternal });
    const open = vi.fn();
    vi.stubGlobal("open", open);

    await openExternalUrl(URL_);

    expect(openExternal).toHaveBeenCalledWith(URL_);
    // Must NOT also open a tab — that would show the consent screen twice.
    expect(open).not.toHaveBeenCalled();
  });

  it("falls back to a tab when the IPC bridge THROWS", async () => {
    // A broken bridge must not strand the user with a dead button.
    electron.mockReturnValue({
      openExternal: async () => {
        throw new Error("ipc gone");
      },
    });
    const open = vi.fn(() => ({}) as Window);
    vi.stubGlobal("open", open);

    await openExternalUrl(URL_);

    expect(open).toHaveBeenCalledWith(URL_, "_blank", "noopener");
  });
});

describe("browser dev (no Electron bridge)", () => {
  it("opens a new tab", async () => {
    electron.mockReturnValue(undefined);
    const open = vi.fn(() => ({}) as Window);
    vi.stubGlobal("open", open);

    await openExternalUrl(URL_);

    expect(open).toHaveBeenCalledWith(URL_, "_blank", "noopener");
  });

  it("navigates the CURRENT tab when the popup is blocked", async () => {
    // Worse UX than a tab, but it still completes the handshake instead of
    // dead-ending — a blocked popup returns null, which is easy to ignore.
    electron.mockReturnValue(undefined);
    vi.stubGlobal("open", vi.fn(() => null));
    const assign = vi.fn();
    vi.stubGlobal("location", { assign });

    await openExternalUrl(URL_);

    expect(assign).toHaveBeenCalledWith(URL_);
  });
});
