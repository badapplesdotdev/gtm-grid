import { describe, expect, it } from "vitest";
import { requiredInputKeys, resolveOptionArgs } from "./option-args.js";

describe("requiredInputKeys", () => {
  it("reads the JSON-Schema `required` array", () => {
    expect(requiredInputKeys({ type: "object", required: ["workspace_id"] })).toEqual(["workspace_id"]);
  });
  it("returns [] for no required, null, or a non-array required", () => {
    expect(requiredInputKeys({ type: "object" })).toEqual([]);
    expect(requiredInputKeys(null)).toEqual([]);
    expect(requiredInputKeys(undefined)).toEqual([]);
    expect(requiredInputKeys({ required: "workspace_id" })).toEqual([]);
  });
});

describe("resolveOptionArgs", () => {
  it("injects a required sibling value (workspace_id → listCampaigns)", () => {
    const { args, missing } = resolveOptionArgs({}, ["workspace_id"], { workspace_id: "ws_1", campaign_id: "" });
    expect(args).toEqual({ workspace_id: "ws_1" });
    expect(missing).toEqual([]);
  });
  it("reports a still-missing required input (so the caller can prompt)", () => {
    const { args, missing } = resolveOptionArgs({}, ["workspace_id"], { campaign_id: "abc" });
    expect(args).toEqual({});
    expect(missing).toEqual(["workspace_id"]);
  });
  it("only injects REQUIRED keys — never the half-picked field or unrelated inputs", () => {
    const { args } = resolveOptionArgs({}, ["workspace_id"], {
      workspace_id: "ws_1",
      campaign_id: "half-picked",
      something_else: "nope",
    });
    expect(args).toEqual({ workspace_id: "ws_1" });
  });
  it("never overwrites a value already present in the source's static args", () => {
    const { args } = resolveOptionArgs({ workspace_id: "fixed" }, ["workspace_id"], { workspace_id: "from-sibling" });
    expect(args.workspace_id).toBe("fixed");
  });
  it("treats blank/nullish sibling values as unset", () => {
    expect(resolveOptionArgs({}, ["workspace_id"], { workspace_id: "" }).missing).toEqual(["workspace_id"]);
  });
  it("is a no-op when the source method requires nothing", () => {
    const { args, missing } = resolveOptionArgs({ a: 1 }, [], { workspace_id: "ws" });
    expect(args).toEqual({ a: 1 });
    expect(missing).toEqual([]);
  });
});
