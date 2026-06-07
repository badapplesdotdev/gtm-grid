/**
 * Unit tests for the desktop deep-link OAuth pure helpers.
 *
 * These cover the parsing/branching units directly, with no DOM/webview:
 *   - code-extraction from the `gtmgrid://auth/callback?code=…` deep-link URL
 *   - the Tauri-vs-web branch selection
 *   - the Tauri-runtime detection
 *
 * The Better Auth session is re-read by the deep-link listener
 * (useApiDeepLinkOAuth); there is no `code` exchange to test here.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { chooseOAuthFlow, extractOAuthCode, isTauri } from "./desktop-oauth";

afterEach(() => {
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
