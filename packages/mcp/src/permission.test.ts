import { describe, expect, it } from "vitest";
import {
  decide,
  hashArgs,
  parseApprovedAction,
  parsePermissionMode,
  permissionConfigured,
  riskClass,
  type PermissionMode,
  type RiskClass,
} from "./permission.js";

describe("parsePermissionMode", () => {
  it("reads a valid mode and defaults absent/invalid to bypassPermissions", () => {
    expect(parsePermissionMode({ GTMGRID_PERMISSION_MODE: "auto" })).toBe("auto");
    expect(parsePermissionMode({ GTMGRID_PERMISSION_MODE: "plan" })).toBe("plan");
    expect(parsePermissionMode({})).toBe("bypassPermissions");
    expect(parsePermissionMode({ GTMGRID_PERMISSION_MODE: "nonsense" })).toBe("bypassPermissions");
  });
  it("permissionConfigured is true only when the mode env is present", () => {
    expect(permissionConfigured({ GTMGRID_PERMISSION_MODE: "auto" })).toBe(true);
    expect(permissionConfigured({})).toBe(false);
  });
});

describe("riskClass", () => {
  it("buckets mutating tools and defaults unknown/read tools to read", () => {
    expect(riskClass("add_column")).toBe("edit");
    expect(riskClass("delete_table")).toBe("destructive");
    expect(riskClass("run_column")).toBe("spend");
    expect(riskClass("get_table")).toBe("read");
    expect(riskClass("something_new")).toBe("read");
  });
});

describe("decide — the mode × risk-class matrix", () => {
  // The full matrix as a table: [mode, class, opts, expected].
  const cases: [PermissionMode, RiskClass, { affected?: number; credits?: number } | undefined, string][] = [
    // read always executes
    ["bypassPermissions", "read", undefined, "execute"],
    ["plan", "read", undefined, "execute"],
    // bypass runs everything
    ["bypassPermissions", "edit", undefined, "execute"],
    ["bypassPermissions", "destructive", { affected: 9999 }, "execute"],
    ["bypassPermissions", "spend", { credits: 5, affected: 9999 }, "execute"],
    // plan blocks every mutation/spend
    ["plan", "edit", undefined, "block"],
    ["plan", "destructive", undefined, "block"],
    ["plan", "spend", { credits: 5 }, "block"],
    ["plan", "spend", { credits: 0 }, "block"],
    // auto
    ["auto", "edit", { affected: 10 }, "execute"],
    ["auto", "edit", { affected: 9999 }, "confirm"], // outsized bulk edit asks
    ["auto", "destructive", { affected: 1 }, "confirm"],
    ["auto", "spend", { credits: 0, affected: 9999 }, "execute"], // free run
    ["auto", "spend", { credits: 1, affected: 10 }, "execute"], // small paid run
    ["auto", "spend", { credits: 1, affected: 9999 }, "confirm"], // large paid run
    // acceptEdits
    ["acceptEdits", "edit", { affected: 10 }, "execute"],
    ["acceptEdits", "destructive", { affected: 1 }, "confirm"],
    ["acceptEdits", "spend", { credits: 0, affected: 9999 }, "execute"], // free run
    ["acceptEdits", "spend", { credits: 1, affected: 1 }, "confirm"], // EVERY paid run asks
  ];
  for (const [mode, cls, opts, expected] of cases) {
    it(`${mode} × ${cls} ${JSON.stringify(opts ?? {})} → ${expected}`, () => {
      expect(decide(mode, cls, opts)).toBe(expected);
    });
  }
});

describe("hashArgs — binds an approval to the exact action", () => {
  it("is stable across key order and ignores the confirm flag", () => {
    expect(hashArgs({ table: "Leads", where: { Status: "x" } })).toBe(
      hashArgs({ where: { Status: "x" }, table: "Leads", confirm: true }),
    );
  });
  it("changes when the action's args change", () => {
    expect(hashArgs({ table: "Leads", where: { Status: "x" } })).not.toBe(
      hashArgs({ table: "Leads", where: { Status: "y" } }),
    );
    expect(hashArgs({ table: "Leads" })).not.toBe(hashArgs({ table: "Accounts" }));
  });
});

describe("parseApprovedAction", () => {
  it("reads the env-passed human approval, or undefined when absent", () => {
    expect(
      parseApprovedAction({ GTMGRID_APPROVED_TOOL: "delete_rows", GTMGRID_APPROVED_ARGS_HASH: "abc" }),
    ).toEqual({ tool: "delete_rows", argsHash: "abc" });
    expect(parseApprovedAction({})).toBeUndefined();
    expect(parseApprovedAction({ GTMGRID_APPROVED_TOOL: "x" })).toBeUndefined();
  });
});
