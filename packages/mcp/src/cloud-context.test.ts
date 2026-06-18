import { describe, expect, it } from "vitest";
import {
  cloudContextFromEnv,
  describeGridEnv,
  selectGridEnv,
  type McpEnv,
} from "./cloud-context.js";

/** A complete cloud env (every field present, mode=cloud). */
const FULL_CLOUD: McpEnv = {
  GTMGRID_MODE: "cloud",
  GTMGRID_API_URL: "https://app.test",
  GTMGRID_TOKEN: "secret-bearer",
  GTMGRID_WORKSPACE_ID: "ws_1",
  GTMGRID_CLOUD_PROJECT: "proj_1",
  GTMGRID_CLOUD_TABLE: "tbl_1",
};

describe("cloudContextFromEnv — explicit, complete cloud context", () => {
  it("resolves the full context when mode=cloud and every field present", () => {
    expect(cloudContextFromEnv(FULL_CLOUD)).toEqual({
      apiUrl: "https://app.test",
      token: "secret-bearer",
      workspaceId: "ws_1",
      projectId: "proj_1",
      tableId: "tbl_1",
    });
  });

  it("is case-insensitive on the mode literal", () => {
    expect(cloudContextFromEnv({ ...FULL_CLOUD, GTMGRID_MODE: "CLOUD" })).not.toBeUndefined();
  });

  it("returns undefined when mode is absent (mode is explicit, never guessed)", () => {
    // apiUrl + token + everything present, but no GTMGRID_MODE → not a cloud context.
    const { GTMGRID_MODE: _omit, ...noMode } = FULL_CLOUD;
    expect(cloudContextFromEnv(noMode)).toBeUndefined();
  });

  it("returns undefined when mode is the string 'local' even with cloud fields", () => {
    expect(cloudContextFromEnv({ ...FULL_CLOUD, GTMGRID_MODE: "local" })).toBeUndefined();
  });

  it.each([
    "GTMGRID_API_URL",
    "GTMGRID_TOKEN",
    "GTMGRID_WORKSPACE_ID",
    "GTMGRID_CLOUD_PROJECT",
    "GTMGRID_CLOUD_TABLE",
  ] as const)("returns undefined when %s is missing (no half-activation)", (key) => {
    const partial: McpEnv = { ...FULL_CLOUD, [key]: undefined };
    expect(cloudContextFromEnv(partial)).toBeUndefined();
  });

  it("treats a blank/whitespace field as missing", () => {
    expect(cloudContextFromEnv({ ...FULL_CLOUD, GTMGRID_TOKEN: "   " })).toBeUndefined();
  });

  it("trims surrounding whitespace from values", () => {
    const ctx = cloudContextFromEnv({ ...FULL_CLOUD, GTMGRID_API_URL: "  https://app.test  " });
    expect(ctx?.apiUrl).toBe("https://app.test");
  });
});

describe("selectGridEnv — cloud is the only data source", () => {
  it("selects CLOUD when a complete cloud context is present", () => {
    const env = selectGridEnv(FULL_CLOUD);
    expect(env.mode).toBe("cloud");
    expect(env.context.projectId).toBe("proj_1");
    expect(env.context.tableId).toBe("tbl_1");
  });

  it("throws when no cloud context is present (the local grid was removed)", () => {
    expect(() => selectGridEnv({})).toThrow();
  });

  it("throws when a build sets an apiUrl but mode is not cloud", () => {
    expect(() => selectGridEnv({ GTMGRID_API_URL: "https://app.test" })).toThrow();
  });

  it("throws when the cloud context is incomplete (token missing)", () => {
    expect(() => selectGridEnv({ ...FULL_CLOUD, GTMGRID_TOKEN: undefined })).toThrow();
  });
});

describe("describeGridEnv — token-free banner (token not logged)", () => {
  it("describes a cloud env by project/table, never the bearer token", () => {
    const line = describeGridEnv(selectGridEnv(FULL_CLOUD));
    expect(line).toContain("proj_1");
    expect(line).toContain("tbl_1");
    expect(line).not.toContain("secret-bearer");
  });
});
