/**
 * The Google Sheets manifest, over a fake fetch.
 *
 * Three things here are easy to get subtly wrong and impossible to notice from
 * reading the JSON:
 *
 * 1. `{spreadsheetId}` / `{range}` are PATH params, so they must be interpolated
 *    and then EXCLUDED from the body — otherwise Google receives a body with
 *    stray keys and rejects the write.
 * 2. `valueInputOption` must ride as a QUERY param on a POST/PUT. The loader
 *    defaults every non-path field into the body for verbs that have one, so
 *    without an explicit `query` list it would silently land in the payload and
 *    Google would append raw strings where the user asked for parsing.
 * 3. `:append` is a literal path suffix, not a param. A greedy template regex
 *    would eat it.
 *
 * Plus the reason the whole feature exists: this connector must resolve the
 * SHARED `google` credential, not one named after itself.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { connectorFromManifest, parseManifest } from "./manifest.js";
import { credentialSlotFor } from "../registry.js";
import manifestJson from "../../../../extensions/googlesheets.json" with { type: "json" };
import type { ConnectorMethod, MethodContext } from "../types.js";

const manifest = parseManifest(manifestJson);
const connector = connectorFromManifest(manifest);

const method = (id: string): ConnectorMethod => {
  const m = connector.methods.find((x) => x.id === id);
  if (!m) throw new Error(`method ${id} missing`);
  return m;
};

const ctx = { secrets: { accessToken: "ya29.token" } } as unknown as MethodContext;

interface Captured {
  url: string;
  method: string;
  body: string;
  auth: string;
}

const capture = (responseBody: unknown = {}): Captured[] => {
  const calls: Captured[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    // Headers are a plain object here, so lookup is case-SENSITIVE — the loader
    // writes the manifest's header name verbatim ("Authorization").
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const authKey = Object.keys(headers).find((k) => k.toLowerCase() === "authorization");
    calls.push({
      url: String(url),
      method: String(init?.method ?? "GET"),
      body: String(init?.body ?? ""),
      auth: authKey === undefined ? "" : headers[authKey],
    });
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  return calls;
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("credential wiring", () => {
  it("reads the SHARED 'google' slot, not a slot named after itself", () => {
    // The entire reason `credentialSlot` was added: one Google grant serves
    // Sheets, Docs and Gmail. If this returns "googlesheets", the user is asked
    // to connect Google once per connector.
    expect(connector.id).toBe("googlesheets");
    expect(credentialSlotFor(connector, connector.id)).toBe("google");
  });

  it("sends the access token as a bearer", async () => {
    const calls = capture({ values: [] });
    await method("getValues").run({ spreadsheetId: "abc", range: "Sheet1!A1:B2" }, ctx);
    expect(calls[0]?.auth).toBe("Bearer ya29.token");
  });

  it("tells the user to CONNECT, not to check a key, when no token is present", async () => {
    // OAuth users have no key to paste; key-flavoured copy is a dead end.
    await expect(
      method("getValues").run({ spreadsheetId: "abc", range: "A1" }, { secrets: {} } as MethodContext),
    ).rejects.toThrow(/connect/i);
  });
});

describe("getValues", () => {
  it("interpolates both path params and puts options in the query", async () => {
    const calls = capture({ values: [["a", "b"]] });
    await method("getValues").run(
      { spreadsheetId: "sheet_1", range: "Sheet1!A1:D50", majorDimension: "COLUMNS" },
      ctx,
    );

    const url = new URL(calls[0]?.url ?? "");
    expect(url.pathname).toBe("/v4/spreadsheets/sheet_1/values/Sheet1!A1%3AD50");
    expect(url.searchParams.get("majorDimension")).toBe("COLUMNS");
    // Path params must not be duplicated into the query string.
    expect(url.searchParams.has("spreadsheetId")).toBe(false);
    expect(url.searchParams.has("range")).toBe(false);
    expect(calls[0]?.method).toBe("GET");
  });

  it("surfaces the values array as the cell result", async () => {
    capture({ range: "Sheet1!A1:B1", majorDimension: "ROWS", values: [["Acme", "acme.com"]] });
    const out = await method("getValues").run({ spreadsheetId: "s", range: "Sheet1!A1:B1" }, ctx);
    expect(out).toEqual([["Acme", "acme.com"]]);
  });
});

describe("appendRow", () => {
  it("keeps :append literal and sends values in the body", async () => {
    const calls = capture({ updates: { updatedRange: "Sheet1!A5:B5" } });
    await method("appendRow").run(
      { spreadsheetId: "sheet_1", range: "Sheet1", values: [["Acme", "acme.com"]] },
      ctx,
    );

    expect(calls[0]?.method).toBe("POST");
    const url = new URL(calls[0]?.url ?? "");
    expect(url.pathname).toBe("/v4/spreadsheets/sheet_1/values/Sheet1:append");

    const body: unknown = JSON.parse(calls[0]?.body ?? "{}");
    expect(body).toEqual({ values: [["Acme", "acme.com"]] });
  });

  it("puts valueInputOption in the QUERY and keeps it out of the body", async () => {
    // The default would have buried it in the payload, where Google ignores it —
    // silently storing "0123" and "=SUM(A1:A2)" as literal text.
    const calls = capture({ updates: { updatedRange: "Sheet1!A5" } });
    await method("appendRow").run(
      {
        spreadsheetId: "s",
        range: "Sheet1",
        values: [["x"]],
        valueInputOption: "RAW",
        insertDataOption: "OVERWRITE",
      },
      ctx,
    );

    const url = new URL(calls[0]?.url ?? "");
    expect(url.searchParams.get("valueInputOption")).toBe("RAW");
    expect(url.searchParams.get("insertDataOption")).toBe("OVERWRITE");

    const body = JSON.parse(calls[0]?.body ?? "{}") as Record<string, unknown>;
    expect(body).toEqual({ values: [["x"]] });
    expect(body.valueInputOption).toBeUndefined();
    expect(body.spreadsheetId).toBeUndefined();
    expect(body.range).toBeUndefined();
  });

  it("reports the updated range as the cell result", async () => {
    capture({ spreadsheetId: "s", updates: { updatedRange: "Sheet1!A5:B5", updatedRows: 1 } });
    const out = await method("appendRow").run(
      { spreadsheetId: "s", range: "Sheet1", values: [["a"]] },
      ctx,
    );
    expect(out).toBe("Sheet1!A5:B5");
  });
});

describe("updateValues", () => {
  it("PUTs to the exact range with values in the body", async () => {
    const calls = capture({ updatedRange: "Sheet1!B2:C2" });
    await method("updateValues").run(
      { spreadsheetId: "s", range: "Sheet1!B2:C2", values: [["done", "ok"]] },
      ctx,
    );

    expect(calls[0]?.method).toBe("PUT");
    expect(new URL(calls[0]?.url ?? "").pathname).toBe("/v4/spreadsheets/s/values/Sheet1!B2%3AC2");
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ values: [["done", "ok"]] });
  });
});

describe("listSheets", () => {
  it("drives the tab picker from sheets[].properties.title", async () => {
    // The option source declared on appendRow.range reads exactly these paths;
    // a rename on either side silently empties the dropdown.
    const optionSource = manifest.methods.find((m) => m.id === "appendRow")?.options?.range;
    expect(optionSource).toMatchObject({
      method: "listSheets",
      itemsPath: "sheets",
      labelKey: "properties.title",
      valueKey: "properties.title",
    });

    const calls = capture({ sheets: [{ properties: { title: "Leads" } }] });
    await method("listSheets").run({ spreadsheetId: "s" }, ctx);
    expect(new URL(calls[0]?.url ?? "").pathname).toBe("/v4/spreadsheets/s");
  });
});

describe("manifest shape", () => {
  it("declares a rate limit, so it never falls back to the 2rps default", () => {
    expect(manifest.rateLimit).toEqual({ rpm: 60, concurrency: 2 });
  });

  it("charges no credits — the user's own Google quota is the only cost", () => {
    for (const m of manifest.methods) expect(m.credits).toBe(0);
  });
});
