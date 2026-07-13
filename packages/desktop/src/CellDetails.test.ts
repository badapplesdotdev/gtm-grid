import { describe, it, expect } from "vitest";
import { flatten, extractCode } from "./CellDetails";

/** Run a generated extractCode body against a source value, the way a column
 *  would: the cell value is interpolated to its JSON string in `inputs.src`. */
function run(path: string[], src: unknown): unknown {
  const make = new Function(`return (${extractCode(path)})`) as () => (i: { src: string }) => unknown;
  return make()({ src: typeof src === "string" ? src : JSON.stringify(src) });
}

const paths = (v: unknown) => flatten(v).map((f) => f.path.join("."));

describe("flatten — arrays are first-class", () => {
  it("expands an array of scalars into the container plus indexed elements", () => {
    const fields = flatten({ email: ["a@x.com", "b@y.com"] });
    expect(fields).toEqual([
      { path: ["email"], value: ["a@x.com", "b@y.com"], type: "array" },
      { path: ["email", "0"], value: "a@x.com", type: "string" },
      { path: ["email", "1"], value: "b@y.com", type: "string" },
    ]);
  });

  it("expands an array of objects down to each element's leaves", () => {
    expect(paths({ contacts: [{ email: "a" }, { email: "b" }] })).toEqual([
      "contacts",
      "contacts.0.email",
      "contacts.1.email",
    ]);
  });

  it("expands a top-level array (container path is empty, elements indexed)", () => {
    expect(paths(["x@a.com", "y@b.com"])).toEqual(["", "0", "1"]);
  });

  it("keeps an empty array as a single mappable field", () => {
    expect(flatten({ tags: [] })).toEqual([{ path: ["tags"], value: [], type: "array" }]);
  });

  it("caps element drill-in but always keeps the container as the escape hatch", () => {
    const big = Array.from({ length: 250 }, (_, i) => i);
    const fields = flatten({ ids: big });
    // 1 container + 100 capped elements.
    expect(fields).toHaveLength(101);
    expect(fields[0]).toEqual({ path: ["ids"], value: big, type: "array" });
  });
});

describe("extractCode — resolves array element paths", () => {
  it("pulls a single element out of an array field", () => {
    expect(run(["email", "0"], { email: ["a@x.com", "b@y.com"] })).toBe("a@x.com");
    expect(run(["email", "1"], { email: ["a@x.com", "b@y.com"] })).toBe("b@y.com");
  });

  it("pulls a leaf out of an array of objects", () => {
    expect(run(["contacts", "1", "email"], { contacts: [{ email: "a" }, { email: "b" }] })).toBe("b");
  });

  it("still maps the whole array as JSON when the container is chosen", () => {
    expect(run(["email"], { email: ["a@x.com", "b@y.com"] })).toBe('["a@x.com","b@y.com"]');
  });

  it("resolves a top-level array element", () => {
    expect(run(["0"], ["x@a.com", "y@b.com"])).toBe("x@a.com");
  });

  it("returns null for an out-of-range index instead of throwing", () => {
    expect(run(["email", "5"], { email: ["a@x.com"] })).toBeNull();
  });
});
