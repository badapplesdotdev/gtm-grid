import { describe, it, expect } from "vitest";
import { missingInputs } from "./columnInputs";

const cols = new Set(["Full Name", "Domain", "Email"]);

describe("missingInputs", () => {
  it("returns nothing when every required input is mapped to an existing column", () => {
    expect(
      missingInputs({ name: "{{Full Name}}", domain: "{{Domain}}" }, ["name", "domain"], cols),
    ).toEqual([]);
  });

  it("flags unset required params", () => {
    expect(missingInputs({ name: "{{Full Name}}" }, ["name", "domain"], cols)).toEqual(["domain"]);
    expect(missingInputs({ name: "   ", domain: "{{Domain}}" }, ["name", "domain"], cols)).toEqual(["name"]);
  });

  it("flags references to columns that no longer exist", () => {
    expect(missingInputs({ name: "{{Deleted Col}}" }, ["name"], cols)).toEqual(["{{Deleted Col}}"]);
  });

  it("accepts literal (non-reference) values for required params", () => {
    expect(missingInputs({ domain: "acme.com" }, ["domain"], cols)).toEqual([]);
  });

  it("recurses into nested objects and arrays (HTTP-style params)", () => {
    const params = {
      url: "https://api.example.com?d={{Domain}}",
      headers: { Authorization: "Bearer {{Missing Key}}" },
      body: ["{{Email}}", { x: "{{Also Missing}}" }],
    };
    expect(missingInputs(params, [], cols).sort()).toEqual(["{{Also Missing}}", "{{Missing Key}}"]);
  });

  it("tolerates whitespace inside the braces", () => {
    expect(missingInputs({ name: "{{  Full Name  }}" }, ["name"], cols)).toEqual([]);
  });

  it("dedupes repeated broken references", () => {
    expect(missingInputs({ a: "{{Gone}}", b: "{{Gone}}" }, [], cols)).toEqual(["{{Gone}}"]);
  });
});
