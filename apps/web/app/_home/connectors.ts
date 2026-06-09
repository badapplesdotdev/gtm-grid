// The real connector catalog — sourced from the JSON manifests in /extensions
// (method counts via `jq '.methods | keys | length'`). Each connector ships as
// one declarative manifest that becomes an sdk call, an MCP tool, and a UI form.
// Trigify is featured (it's the in-house signal/enrichment engine).

export interface Connector {
  readonly name: string;
  /** Domain used for the favicon (Google s2). Omit when there's no clean site. */
  readonly domain?: string;
  /** 2-letter monogram fallback when a favicon fails or is omitted. */
  readonly mono: string;
  /** Number of methods exposed by the manifest. */
  readonly methods: number;
  readonly featured?: boolean;
}

// Ordered by method count (impact) with the featured connector first.
export const CONNECTORS: readonly Connector[] = [
  { name: "Trigify", domain: "trigify.io", mono: "Tg", methods: 119, featured: true },
  { name: "HubSpot", domain: "hubspot.com", mono: "Hs", methods: 77 },
  { name: "Attio", domain: "attio.com", mono: "At", methods: 58 },
  { name: "Instantly", domain: "instantly.ai", mono: "In", methods: 40 },
  { name: "PlusVibe", domain: "plusvibe.ai", mono: "Pv", methods: 26 },
  { name: "LeadMagic", domain: "leadmagic.io", mono: "Lm", methods: 20 },
  { name: "The Companies API", domain: "thecompaniesapi.com", mono: "Tc", methods: 18 },
  { name: "Smuggler", mono: "Sm", methods: 10 },
  { name: "Prospeo", domain: "prospeo.io", mono: "Pr", methods: 8 },
  { name: "FindyMail", domain: "findymail.com", mono: "Fm", methods: 6 },
  { name: "Smartlead", domain: "smartlead.ai", mono: "Sl", methods: 6 },
  { name: "Apollo.io", domain: "apollo.io", mono: "Ap", methods: 5 },
  { name: "Apify", domain: "apify.com", mono: "Ay", methods: 4 },
  { name: "Exa", domain: "exa.ai", mono: "Ex", methods: 4 },
  { name: "Reoon", domain: "reoon.com", mono: "Re", methods: 4 },
  { name: "FullEnrich", domain: "fullenrich.com", mono: "Fe", methods: 3 },
  { name: "BetterContact", domain: "bettercontact.rocks", mono: "Bc", methods: 2 },
  { name: "Granola", domain: "granola.ai", mono: "Gr", methods: 2 },
  { name: "Avtrz", mono: "Av", methods: 1 },
  { name: "Fireflies", domain: "fireflies.ai", mono: "Ff", methods: 1 },
];

export const CONNECTOR_COUNT = CONNECTORS.length;
export const TOTAL_METHODS = CONNECTORS.reduce((n, c) => n + c.methods, 0);

export const faviconUrl = (domain: string): string =>
  `https://www.google.com/s2/favicons?domain=${domain}&sz=128`;
