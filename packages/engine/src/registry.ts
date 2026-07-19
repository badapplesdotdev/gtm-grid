// Connector registry — the unified catalog of callable methods. Same registry
// feeds the sandbox sdk, the MCP tool list, and the UI function browser.

import type { Connector, ConnectorMethod } from "./types.js";
import { aiConnector } from "./connectors/ai.js";
import { githubConnector } from "./connectors/github.js";
import { formattingConnector } from "./connectors/formatting.js";
import { formulaConnector } from "./connectors/formula.js";
import { httpRequestConnector } from "./connectors/http-request.js";
import { tableConnector } from "./connectors/table.js";
import { connectorFromManifest, parseManifest } from "./connectors/manifest.js";
import { BUNDLED_MANIFESTS } from "./bundled-manifests.generated.js";

export class Registry {
  private connectors = new Map<string, Connector>();

  constructor(connectors: Connector[]) {
    for (const c of connectors) this.connectors.set(c.id, c);
  }

  add(connector: Connector): void {
    this.connectors.set(connector.id, connector);
  }

  list(): Connector[] {
    return [...this.connectors.values()];
  }

  get(id: string): Connector | undefined {
    return this.connectors.get(id);
  }

  method(provider: string, method: string): ConnectorMethod | undefined {
    return this.connectors.get(provider)?.methods.find((m) => m.id === method);
  }

  /** provider -> method ids, used to materialise the sandbox sdk. */
  providerMap(): Record<string, string[]> {
    const map: Record<string, string[]> = {};
    for (const c of this.connectors.values()) map[c.id] = c.methods.map((m) => m.id);
    return map;
  }
}

/**
 * Which credential row a connector's calls authenticate with.
 *
 * Defaults to the connector's own id, which is what every connector predating
 * this helper relied on — so an absent `credentialSlot` is exactly the old
 * behaviour, and no existing manifest changes meaning.
 *
 * The override exists for provider FAMILIES. Google mints ONE grant covering
 * Sheets, Docs and Gmail; without a shared slot each of those connectors would
 * demand its own connection and the user would authorise Google once per
 * connector. Only the `oauth` arm may share a slot: two `apiKey` connectors
 * pointing at one row would let the Tools panel's "Replace key" on either of
 * them silently overwrite the other's secret.
 *
 * `undefined` connector (an id with no registered connector) falls back to the
 * id too, so a lookup miss degrades to the old behaviour rather than throwing.
 */
export function credentialSlotFor(connector: Connector | undefined, connectorId: string): string {
  const auth = connector?.auth;
  if (auth?.type === "oauth" && auth.credentialSlot) return auth.credentialSlot;
  return connectorId;
}

export function defaultRegistry(): Registry {
  return new Registry([
    aiConnector,
    formattingConnector,
    formulaConnector,
    githubConnector,
    httpRequestConnector,
    tableConnector,
  ]);
}

/**
 * The connectors built from the manifests bundled with the app
 * (`extensions/*.json`, inlined as {@link BUNDLED_MANIFESTS}). These ship with
 * every build and must be available WHEREVER columns run.
 *
 * The desktop sidecar seeds them from disk at startup
 * (`packages/server/src/index.ts`); the cloud webhook worker (apps/web Inngest)
 * has no disk access to `extensions/`, so it calls this to register the same
 * connectors before a run — without it, a column calling `sdk["trigify"][…]`
 * (or any bundled connector) hits an undefined `sdk[provider]` in the QuickJS
 * guest and the run fails with "sandbox: cannot read property …".
 *
 * A malformed bundled manifest is SKIPPED rather than throwing, so one bad entry
 * can never strip every other connector from the registry.
 */
export function bundledConnectors(): Connector[] {
  const out: Connector[] = [];
  for (const manifest of BUNDLED_MANIFESTS) {
    try {
      out.push(connectorFromManifest(parseManifest(manifest)));
    } catch {
      /* skip a single malformed bundled manifest — never fail the whole set */
    }
  }
  return out;
}
