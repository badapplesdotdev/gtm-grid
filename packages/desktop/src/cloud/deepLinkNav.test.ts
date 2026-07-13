/**
 * Tests for `gtmgrid://open/...` deep-link parsing + the pending-destination
 * store. The parser is asserted exhaustively across every grammar form so the
 * App's navigation effect can route unconditionally; the store's observable
 * contract (set / get / clear / subscribe, consume-once) is asserted directly
 * without React rendering (the node test env does not support hooks).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseOpenDeepLink,
  setPendingDestination,
  getPendingDestination,
  clearPendingDestination,
  subscribePendingDestination,
  type DeepLinkDestination,
} from "./deepLinkNav";

afterEach(() => {
  clearPendingDestination();
});

describe("parseOpenDeepLink — recognised grammar", () => {
  it("bare gtmgrid://open → focus (show/focus the window only)", () => {
    expect(parseOpenDeepLink("gtmgrid://open")).toEqual({ kind: "focus" });
  });

  it("a trailing slash on the bare link is still focus", () => {
    expect(parseOpenDeepLink("gtmgrid://open/")).toEqual({ kind: "focus" });
  });

  it("table/<id> without a workspace → table with null workspace", () => {
    expect(parseOpenDeepLink("gtmgrid://open/table/tbl_123")).toEqual({
      kind: "table",
      tableId: "tbl_123",
      workspaceId: null,
    });
  });

  it("table/<id>?workspace=<id> → table carrying the workspace", () => {
    expect(
      parseOpenDeepLink("gtmgrid://open/table/tbl_123?workspace=ws_9"),
    ).toEqual({ kind: "table", tableId: "tbl_123", workspaceId: "ws_9" });
  });

  it("an empty workspace param is treated as no workspace", () => {
    expect(parseOpenDeepLink("gtmgrid://open/table/tbl_123?workspace=")).toEqual(
      { kind: "table", tableId: "tbl_123", workspaceId: null },
    );
  });

  it("a trailing slash after the table id is tolerated (empty segment dropped)", () => {
    expect(parseOpenDeepLink("gtmgrid://open/table/tbl_123/")).toEqual({
      kind: "table",
      tableId: "tbl_123",
      workspaceId: null,
    });
  });

  it("url-decodes the table id and workspace id", () => {
    expect(
      parseOpenDeepLink("gtmgrid://open/table/a%2Fb?workspace=w%20s"),
    ).toEqual({ kind: "table", tableId: "a/b", workspaceId: "w s" });
  });

  it("new-table → the new-table chooser", () => {
    expect(parseOpenDeepLink("gtmgrid://open/new-table")).toEqual({
      kind: "new-table",
    });
  });

  it("settings/ai-providers → the AI-provider panel", () => {
    expect(parseOpenDeepLink("gtmgrid://open/settings/ai-providers")).toEqual({
      kind: "ai-providers",
    });
  });

  it("invite → the invite / members UI", () => {
    expect(parseOpenDeepLink("gtmgrid://open/invite")).toEqual({
      kind: "invite",
    });
  });

  it("members is an alias for invite", () => {
    expect(parseOpenDeepLink("gtmgrid://open/members")).toEqual({
      kind: "invite",
    });
  });

  it("billing → the billing / plan UI", () => {
    expect(parseOpenDeepLink("gtmgrid://open/billing")).toEqual({
      kind: "billing",
    });
  });

  it("crm-connected → the CRM-connected resume destination", () => {
    expect(parseOpenDeepLink("gtmgrid://open/crm-connected")).toEqual({
      kind: "crm-connected",
    });
  });

  it("ignores a trailing query/hash on crm-connected (OAuth bounce params)", () => {
    expect(
      parseOpenDeepLink("gtmgrid://open/crm-connected?workspace=ws_9#ok"),
    ).toEqual({ kind: "crm-connected" });
  });

  it("matches the scheme + destination keywords case-insensitively", () => {
    expect(parseOpenDeepLink("GTMGRID://OPEN/NEW-TABLE")).toEqual({
      kind: "new-table",
    });
    expect(parseOpenDeepLink("gtmgrid://open/Settings/AI-Providers")).toEqual({
      kind: "ai-providers",
    });
    expect(parseOpenDeepLink("gtmgrid://open/Members")).toEqual({
      kind: "invite",
    });
    expect(parseOpenDeepLink("gtmgrid://open/CRM-Connected")).toEqual({
      kind: "crm-connected",
    });
  });

  it("preserves the original case of the table + workspace ids", () => {
    expect(parseOpenDeepLink("gtmgrid://open/table/TbL_AbC?workspace=Ws_XyZ")).toEqual(
      { kind: "table", tableId: "TbL_AbC", workspaceId: "Ws_XyZ" },
    );
  });

  it("ignores a trailing query/hash on keyword destinations", () => {
    expect(parseOpenDeepLink("gtmgrid://open/billing?ref=email#top")).toEqual({
      kind: "billing",
    });
  });
});

describe("parseOpenDeepLink — non-open links are ignored (null)", () => {
  it("returns null for the OAuth callback so that flow is untouched", () => {
    expect(parseOpenDeepLink("gtmgrid://auth/callback")).toBeNull();
    expect(parseOpenDeepLink("gtmgrid://auth/callback?code=x")).toBeNull();
  });

  it("returns null for an invite token link so that flow is untouched", () => {
    expect(parseOpenDeepLink("gtmgrid://invite/tok123")).toBeNull();
    expect(parseOpenDeepLink("gtmgrid://invite/tok123?x=1")).toBeNull();
  });

  it("returns null for an unknown open destination", () => {
    expect(parseOpenDeepLink("gtmgrid://open/wat")).toBeNull();
    expect(parseOpenDeepLink("gtmgrid://open/settings")).toBeNull();
    expect(parseOpenDeepLink("gtmgrid://open/settings/unknown")).toBeNull();
    expect(parseOpenDeepLink("gtmgrid://open/table")).toBeNull();
    expect(parseOpenDeepLink("gtmgrid://open/table/")).toBeNull();
  });

  it("returns null for a garbled table path with extra segments", () => {
    expect(parseOpenDeepLink("gtmgrid://open/table/tbl_1/extra")).toBeNull();
    expect(parseOpenDeepLink("gtmgrid://open/new-table/extra")).toBeNull();
    expect(parseOpenDeepLink("gtmgrid://open/crm-connected/extra")).toBeNull();
  });

  it("returns null for the wrong scheme or host", () => {
    expect(parseOpenDeepLink("https://example.com/open/billing")).toBeNull();
    expect(parseOpenDeepLink("gtmgrid://opened/billing")).toBeNull();
    expect(parseOpenDeepLink("othergrid://open/billing")).toBeNull();
  });

  it("returns null for empty / garbage / malformed input", () => {
    expect(parseOpenDeepLink("")).toBeNull();
    expect(parseOpenDeepLink("   ")).toBeNull();
    expect(parseOpenDeepLink("not a url")).toBeNull();
    expect(parseOpenDeepLink("gtmgrid://")).toBeNull();
  });
});

describe("pending-destination store — consume-once semantics", () => {
  it("starts empty", () => {
    expect(getPendingDestination()).toBeNull();
  });

  it("captures a set destination and reads it back", () => {
    const dest: DeepLinkDestination = { kind: "billing" };
    setPendingDestination(dest);
    expect(getPendingDestination()).toEqual(dest);
  });

  it("clear consumes the destination so it does not re-fire", () => {
    setPendingDestination({ kind: "invite" });
    expect(getPendingDestination()).not.toBeNull();
    clearPendingDestination();
    expect(getPendingDestination()).toBeNull();
  });

  it("a later set replaces the prior pending destination", () => {
    setPendingDestination({ kind: "new-table" });
    setPendingDestination({ kind: "ai-providers" });
    expect(getPendingDestination()).toEqual({ kind: "ai-providers" });
  });

  it("notifies subscribers on set and on clear", () => {
    const cb = vi.fn();
    const unsub = subscribePendingDestination(cb);
    setPendingDestination({ kind: "billing" });
    expect(cb).toHaveBeenCalledTimes(1);
    clearPendingDestination();
    expect(cb).toHaveBeenCalledTimes(2);
    unsub();
    setPendingDestination({ kind: "invite" });
    expect(cb).toHaveBeenCalledTimes(2); // unsubscribed: no further calls
  });

  it("clear on an already-empty store does not notify", () => {
    const cb = vi.fn();
    const unsub = subscribePendingDestination(cb);
    clearPendingDestination();
    expect(cb).not.toHaveBeenCalled();
    unsub();
  });
});
