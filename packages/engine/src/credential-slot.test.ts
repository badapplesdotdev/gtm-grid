// Which credential row a connector's calls authenticate with.
//
// Until `credentialSlot` existed, the slot WAS the connector id: `Engine.dispatch`
// looked the credential up by the same string it used to find the connector. That
// is correct while one OAuth grant serves one connector, and wrong for a provider
// FAMILY — Google mints a single grant covering Sheets, Docs and Gmail, so without
// a shared slot the user would authorise Google once per connector.
//
// The risk in that change is regression, not the new path: every existing manifest
// omits `credentialSlot`, so the default MUST resolve to the connector id exactly
// as before. These tests pin both arms, and pin that the sharing is restricted to
// oauth — two apiKey connectors sharing a row would let "Replace key" on either
// silently destroy the other's secret.

import { describe, expect, it } from "vitest";
import { connectorFromManifest, parseManifest } from "./connectors/manifest.js";
import { Registry, credentialSlotFor } from "./registry.js";
import type { Connector } from "./types.js";

const build = (auth: unknown, id = "googlesheets"): Connector =>
  connectorFromManifest(
    parseManifest({
      id,
      name: id,
      baseUrl: "https://sheets.googleapis.com/v4",
      auth,
      methods: [{ id: "getValues", description: "Read a range", verb: "GET", path: "/values" }],
    }),
  );

describe("credentialSlotFor", () => {
  it("falls back to the connector id when no slot is declared", () => {
    // The behaviour every pre-existing connector depends on.
    const c = build({ type: "oauth", provider: "slack" }, "slack");
    expect(credentialSlotFor(c, "slack")).toBe("slack");
  });

  it("uses the declared slot so a provider family shares ONE grant", () => {
    const c = build({ type: "oauth", provider: "google", credentialSlot: "google" });
    expect(credentialSlotFor(c, "googlesheets")).toBe("google");
  });

  it("points every connector in a family at the same row", () => {
    // The actual point of the feature: one Google connection, many connectors.
    const slots = ["googlesheets", "googledocs", "gmail"].map((id) =>
      credentialSlotFor(build({ type: "oauth", provider: "google", credentialSlot: "google" }, id), id),
    );
    expect(slots).toEqual(["google", "google", "google"]);
  });

  it("ignores a slot on an apiKey connector", () => {
    // Sharing a row between pasted-key connectors would make the Tools panel's
    // "Replace key" on one of them clobber the other's secret.
    const c = build({ type: "apiKey", header: "x-api-key", credentialSlot: "google" });
    expect(credentialSlotFor(c, "googlesheets")).toBe("googlesheets");
  });

  it("falls back to the id for a connector with no auth at all", () => {
    const c = build(null);
    expect(credentialSlotFor(c, "googlesheets")).toBe("googlesheets");
  });

  it("falls back to the id when the connector is not registered", () => {
    // A lookup miss must degrade to the old behaviour rather than throw.
    expect(credentialSlotFor(undefined, "googlesheets")).toBe("googlesheets");
  });
});

describe("credentialSlot on the parsed manifest", () => {
  it("is absent when unspecified, so existing manifests are unchanged", () => {
    const auth = parseManifest({
      id: "slack",
      name: "Slack",
      baseUrl: "https://slack.com/api",
      auth: { type: "oauth", provider: "slack" },
      methods: [{ id: "postMessage", description: "Post", verb: "POST", path: "/chat.postMessage" }],
    }).auth;
    expect(auth).toEqual({
      type: "oauth",
      provider: "slack",
      header: "Authorization",
      scheme: "Bearer ",
      secretKey: "accessToken",
    });
  });

  it("survives onto the registered Connector, which is where dispatch reads it", () => {
    const c = build({ type: "oauth", provider: "google", credentialSlot: "google" });
    expect(c.auth).toMatchObject({ type: "oauth", provider: "google", credentialSlot: "google" });
    // And it is reachable the way dispatch reaches it — via the registry.
    const reg = new Registry([c]);
    expect(credentialSlotFor(reg.get("googlesheets"), "googlesheets")).toBe("google");
  });

  it("rejects an empty slot rather than silently treating it as absent", () => {
    expect(() =>
      parseManifest({
        id: "googlesheets",
        name: "Google Sheets",
        baseUrl: "https://sheets.googleapis.com/v4",
        auth: { type: "oauth", provider: "google", credentialSlot: "" },
        methods: [{ id: "getValues", description: "Read", verb: "GET", path: "/values" }],
      }),
    ).toThrow();
  });
});
