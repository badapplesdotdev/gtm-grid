// Connector registry — the unified catalog of callable methods. Same registry
// feeds the sandbox sdk, the MCP tool list, and the UI function browser.

import type { Connector, ConnectorMethod } from "./types.js";
import { aiConnector } from "./connectors/ai.js";
import { githubConnector } from "./connectors/github.js";
import { formattingConnector } from "./connectors/formatting.js";
import { formulaConnector } from "./connectors/formula.js";

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

export function defaultRegistry(): Registry {
  return new Registry([aiConnector, formattingConnector, formulaConnector, githubConnector]);
}
