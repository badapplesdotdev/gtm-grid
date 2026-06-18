// Config-shape coverage for per-connector rate limiting. Two guarantees:
//   1. SNAPSHOT — the resolved rate-limit shape of every bundled extension (and
//      the built-in connectors) is pinned, so any change to a provider's
//      researched limits is surfaced in review instead of slipping through.
//   2. COMPLETENESS — every bundled extension method resolves an EXPLICIT rate
//      limit; none silently falls back to the engine's conservative default,
//      which would mean we shipped a provider without respecting its real limits.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { aiConnector } from "./connectors/ai.js";
import { githubConnector } from "./connectors/github.js";
import { connectorFromManifest, parseManifest } from "./connectors/manifest.js";
import { DEFAULT_RATE_LIMIT } from "./execute.js";
import type { Connector, RateLimit } from "./types.js";

// packages/engine/src → repo root → extensions/
const EXT_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../extensions");

const extensionFiles = readdirSync(EXT_DIR)
  .filter((f) => f.endsWith(".json"))
  .sort();

/** Parse every bundled manifest into a runnable connector (also validates the schema). */
const bundledConnectors: Connector[] = extensionFiles.map((f) =>
  connectorFromManifest(parseManifest(JSON.parse(readFileSync(join(EXT_DIR, f), "utf8")))),
);

/** The rate-limit shape of one connector: its default + each method's resolved limit. */
const rateLimitShape = (c: Connector) => ({
  connector: c.rateLimit ?? null,
  methods: Object.fromEntries(
    [...c.methods]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((m) => [m.id, m.rateLimit ?? null] as const),
  ),
});

describe("bundled extension rate-limit config", () => {
  it("ships the expected set of extensions", () => {
    // A canary on the bundled set itself — adding/removing a provider is a
    // deliberate change that should show up in the snapshot below too.
    expect(bundledConnectors.map((c) => c.id).sort()).toMatchSnapshot();
  });

  it("pins the rate-limit shape of every bundled connector", () => {
    const shapes = Object.fromEntries(
      bundledConnectors
        .slice()
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((c) => [c.id, rateLimitShape(c)] as const),
    );
    expect(shapes).toMatchSnapshot();
  });

  it("gives every bundled method an EXPLICIT rate limit (never the silent default)", () => {
    const unconfigured: string[] = [];
    for (const c of bundledConnectors) {
      for (const m of c.methods) {
        if (m.rateLimit === undefined) unconfigured.push(`${c.id}.${m.id}`);
      }
    }
    expect(unconfigured).toEqual([]);
  });

  it("declares only sane positive limits", () => {
    const seen: RateLimit[] = [
      ...bundledConnectors.flatMap((c) => (c.rateLimit ? [c.rateLimit] : [])),
      ...bundledConnectors.flatMap((c) => c.methods.flatMap((m) => (m.rateLimit ? [m.rateLimit] : []))),
    ];
    for (const rl of seen) {
      if (rl.rps !== undefined) expect(rl.rps).toBeGreaterThan(0);
      if (rl.rpm !== undefined) expect(rl.rpm).toBeGreaterThan(0);
      if (rl.concurrency !== undefined) expect(rl.concurrency).toBeGreaterThan(0);
    }
  });
});

describe("built-in connector rate-limit config", () => {
  it("pins the built-in shapes and the safety default", () => {
    expect({
      default: DEFAULT_RATE_LIMIT,
      ai: aiConnector.rateLimit ?? null,
      github: githubConnector.rateLimit ?? null,
    }).toMatchSnapshot();
  });
});
