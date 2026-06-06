/**
 * Unit tests for the desktop deep-link OAuth helpers (C29).
 *
 * These cover the two acceptance-criteria units directly, with no DOM/webview:
 *   - code-extraction from the `gtmgrid://auth/callback?code=…` deep-link URL
 *   - the Tauri-vs-web branch selection
 *   - the start→complete handoff (open URL in browser → exchange code), with the
 *     `signIn` / opener dependencies substituted by simple recording stubs (the
 *     unit under test — the parsing/branching/handoff — is NOT mocked away).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type SignIn,
  chooseOAuthFlow,
  clearPendingProvider,
  completeDesktopOAuth,
  extractOAuthCode,
  getPendingProvider,
  handleDeepLinkCallback,
  isTauri,
  startDesktopOAuth,
  OAUTH_REDIRECT_URL,
} from "./desktop-oauth";

afterEach(() => {
  clearPendingProvider();
  vi.unstubAllGlobals();
});

describe("extractOAuthCode", () => {
  it("pulls the code from a gtmgrid:// deep-link callback URL", () => {
    expect(
      extractOAuthCode("gtmgrid://auth/callback?code=abc123&state=xyz"),
    ).toBe("abc123");
  });

  it("pulls the code from a plain https web callback URL", () => {
    expect(
      extractOAuthCode("https://app.example.com/auth?code=web-code"),
    ).toBe("web-code");
  });

  it("returns null when the URL carries no code param", () => {
    expect(extractOAuthCode("gtmgrid://auth/callback?state=only")).toBeNull();
  });

  it("returns null for an empty code value", () => {
    expect(extractOAuthCode("gtmgrid://auth/callback?code=")).toBeNull();
  });

  it("returns null for a malformed URL instead of throwing", () => {
    expect(extractOAuthCode("not a url")).toBeNull();
  });
});

describe("chooseOAuthFlow", () => {
  it("selects the desktop flow inside Tauri", () => {
    expect(chooseOAuthFlow(true)).toBe("tauri");
  });

  it("selects the web flow outside Tauri", () => {
    expect(chooseOAuthFlow(false)).toBe("web");
  });
});

describe("isTauri", () => {
  it("is false when no Tauri global is present", () => {
    vi.stubGlobal("window", {});
    expect(isTauri()).toBe(false);
  });

  it("is true when __TAURI_INTERNALS__ is injected (v2)", () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    expect(isTauri()).toBe(true);
  });

  it("is true when the legacy __TAURI__ global is present", () => {
    vi.stubGlobal("window", { __TAURI__: {} });
    expect(isTauri()).toBe(true);
  });
});

describe("startDesktopOAuth", () => {
  it("requests the redirect with the deep-link redirectTo and opens it in the browser", async () => {
    const calls: Array<[string, unknown]> = [];
    const signIn: SignIn = async (provider, params) => {
      calls.push([provider, params]);
      return { signingIn: false, redirect: new URL("https://github.com/login") };
    };
    const opened: string[] = [];
    const openUrl = async (url: string) => {
      opened.push(url);
    };

    await startDesktopOAuth("github", signIn, openUrl);

    expect(calls).toEqual([["github", { redirectTo: OAUTH_REDIRECT_URL }]]);
    expect(opened).toEqual(["https://github.com/login"]);
    // The provider is remembered so the deep-link callback can complete it.
    expect(getPendingProvider()).toBe("github");
  });

  it("throws (and remembers nothing) when no redirect URL is returned", async () => {
    const signIn: SignIn = async () => ({ signingIn: true });
    const openUrl = vi.fn(async () => {});

    await expect(startDesktopOAuth("google", signIn, openUrl)).rejects.toThrow(
      /redirect URL/,
    );
    expect(openUrl).not.toHaveBeenCalled();
    expect(getPendingProvider()).toBeNull();
  });
});

describe("completeDesktopOAuth", () => {
  it("exchanges the extracted code via signIn(provider, { code })", async () => {
    const calls: Array<[string, unknown]> = [];
    const signIn: SignIn = async (provider, params) => {
      calls.push([provider, params]);
      return { signingIn: true };
    };

    const completed = await completeDesktopOAuth(
      "gtmgrid://auth/callback?code=the-code",
      "google",
      signIn,
    );

    expect(completed).toBe(true);
    expect(calls).toEqual([["google", { code: "the-code" }]]);
  });

  it("is a no-op (returns false) when the URL has no code", async () => {
    const signIn = vi.fn<SignIn>(async () => ({ signingIn: false }));

    const completed = await completeDesktopOAuth(
      "gtmgrid://auth/callback",
      "github",
      signIn,
    );

    expect(completed).toBe(false);
    expect(signIn).not.toHaveBeenCalled();
  });
});

describe("handleDeepLinkCallback", () => {
  it("completes using the in-flight provider and clears it", async () => {
    const calls: Array<[string, unknown]> = [];
    const signIn: SignIn = async (provider, params) => {
      calls.push([provider, params]);
      return { signingIn: true };
    };

    // Simulate a started flow without opening a real browser.
    const opened: string[] = [];
    await startDesktopOAuth(
      "github",
      async () => ({
        signingIn: false,
        redirect: new URL("https://github.com/login"),
      }),
      async (u) => {
        opened.push(u);
      },
    );
    expect(getPendingProvider()).toBe("github");

    const handled = await handleDeepLinkCallback(
      "gtmgrid://auth/callback?code=cb-code",
      signIn,
    );

    expect(handled).toBe(true);
    expect(calls).toEqual([["github", { code: "cb-code" }]]);
    expect(getPendingProvider()).toBeNull();
  });

  it("ignores callbacks when no flow is in flight", async () => {
    const signIn = vi.fn<SignIn>(async () => ({ signingIn: false }));

    const handled = await handleDeepLinkCallback(
      "gtmgrid://auth/callback?code=stray",
      signIn,
    );

    expect(handled).toBe(false);
    expect(signIn).not.toHaveBeenCalled();
  });
});
