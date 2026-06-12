/**
 * Inbound-webhook mapping (`applyMapping`/`valueAtPath`) — including the `$`
 * whole-payload entry that lands every record in the Webhook column as
 * `{ receivedAt, payload }`.
 */

import { describe, expect, it } from "vitest";
import { applyMapping, valueAtPath } from "./webhook-mapping";

const BODY = {
  Email: "a@b.co",
  nested: { url: "https://x.co" },
  items: [{ name: "first" }],
};

describe("valueAtPath", () => {
  it("resolves dotted and bracketed paths", () => {
    expect(valueAtPath(BODY, "Email")).toBe("a@b.co");
    expect(valueAtPath(BODY, "nested.url")).toBe("https://x.co");
    expect(valueAtPath(BODY, "items[0].name")).toBe("first");
  });

  it("returns undefined for missing segments", () => {
    expect(valueAtPath(BODY, "nope.deeper")).toBeUndefined();
  });
});

describe("applyMapping", () => {
  it("maps field paths and skips missing ones", () => {
    expect(
      applyMapping(
        BODY,
        [
          { path: "Email", columnId: "c1" },
          { path: "missing", columnId: "c2" },
        ],
        123,
      ),
    ).toEqual({ c1: "a@b.co" });
  });

  it("maps the `$` entry to {receivedAt, payload} so records are always visible", () => {
    const cells = applyMapping(
      BODY,
      [
        { path: "$", columnId: "col-webhook" },
        { path: "Email", columnId: "c1" },
      ],
      1765537200000,
    );
    expect(cells["col-webhook"]).toEqual({ receivedAt: 1765537200000, payload: BODY });
    expect(cells.c1).toBe("a@b.co");
  });

  it("an empty mapping still yields no cells (legacy webhooks before the heal)", () => {
    expect(applyMapping(BODY, [], 1)).toEqual({});
  });
});
