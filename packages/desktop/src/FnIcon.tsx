// Function/provider icon — brand favicon when present, otherwise a category
// glyph in a tinted box, otherwise monogram initials. Lives in its own module
// (rather than AddColumn.tsx) so the eagerly-loaded DataGrid headers can render
// provider identity without pulling the lazy column-authoring chunk into the
// initial bundle (same split rationale as BrandIcon.tsx).

import type { ReactNode } from "react";
import { BrandIcon } from "./BrandIcon";
import type { ConnectorInfo } from "./api";

// Category glyphs for built-in functions (no brand favicon). Stroke-based, inherit color.
const I = (d: string, extra?: ReactNode) => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    {d.split("|").map((p, i) => <path key={i} d={p} />)}
    {extra}
  </svg>
);

export const CATEGORY_ICON: Record<string, ReactNode> = {
  AI: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2Z" />
      <path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2Z" />
    </svg>
  ),
  Formatting: <span style={{ fontFamily: "var(--font-mono)", fontWeight: 700, fontSize: 13, lineHeight: 1 }}>Aa</span>,
  Formula: <span style={{ fontFamily: "var(--font-mono)", fontStyle: "italic", fontWeight: 700, fontSize: 13, lineHeight: 1 }}>fx</span>,
  Scoring: I("M3 3v18h18|m19 9-5 5-4-4-3 3"),
  Verification: I("M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z|m9 12 2 2 4-4"),
  Scraping: I("M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z|M2 12h20|M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20z"),
  Extraction: I("m12 2 9 5-9 5-9-5 9-5z|m3 12 9 5 9-5|m3 17 9 5 9-5"),
  "Find email": I("M4 4h16v16H4z|m4 6 8 6 8-6"),
  "Verify email": I("M4 4h16v16H4z|m4 6 8 6 8-6"),
  "Find phone": I("M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L16 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"),
  "Enrich people": I("M16 21v-2a4 4 0 0 0-8 0v2|M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z"),
  "Enrich company": I("M3 21h18|M5 21V7l7-4 7 4v14|M9 9h0M9 13h0M9 17h0M15 9h0M15 13h0M15 17h0"),
  Search: I("M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z|m21 21-4.3-4.3"),
  Ads: I("M3 11v2a1 1 0 0 0 1 1h3l5 4V6L7 10H4a1 1 0 0 0-1 1z|M16 9a3 3 0 0 1 0 6"),
  Jobs: I("M3 7h18v13H3z|M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"),
  Signals: I("M4 11a9 9 0 0 1 9 9|M4 4a16 16 0 0 1 16 16|M5 19a1 1 0 1 0 0 .01z"),
  Code: <span style={{ fontFamily: "var(--font-mono)", fontWeight: 700, fontSize: 12, lineHeight: 1 }}>{"{ }"}</span>,
  Other: I("M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z|M3.27 6.96 12 12.01l8.73-5.05|M12 22.08V12"),
};

/** Canonical gallery category order (left nav + group ordering). */
export const CATEGORY_ORDER: string[] = [
  "AI",
  "Formula",
  "Enrich people",
  "Enrich company",
  "Find email",
  "Verify email",
  "Find phone",
  "Search",
  "Formatting",
  "Scoring",
  "Verification",
  "Scraping",
  "Extraction",
  "Ads",
  "Jobs",
  "Signals",
];
const CATEGORY_SET = new Set<string>(CATEGORY_ORDER);

/** Methods with no (or an unknown) explicit category land here — they are
 *  listed under "All" only, never miscategorised into a subsection. */
export const OTHER_CATEGORY = "Other";

/** Resolve a method's gallery category. Categories are EXPLICIT, per method
 *  (set in the connector manifest / built-in definition) — no keyword guessing.
 *  Built-in single-purpose providers carry an implicit category; everything
 *  else without a valid explicit category goes to {@link OTHER_CATEGORY}. */
export function categorize(provider: string, methodCategory?: string | null): string {
  if (methodCategory && CATEGORY_SET.has(methodCategory)) return methodCategory;
  if (provider === "ai") return "AI";
  if (provider === "formula") return "Formula";
  if (provider === "formatting") return "Formatting";
  return OTHER_CATEGORY;
}

/** Presentation metadata for a function column's provider/method, resolved from
 *  the connector catalog. Built by each grid parent (local/cloud) and handed to
 *  DataGrid via the controller's optional `columnMeta` lookup. */
export interface ColumnMeta {
  providerName: string;
  logo: string | null;
  /** Human label, e.g. "Enrich Person" (falls back to the raw method id). */
  methodLabel: string;
  category: string;
  credits?: number;
  /** Required input param names from the method's JSON schema (drives the
   *  "waiting for inputs" affordances). */
  requiredInputs?: string[];
}

// Function icon: brand favicon when present, otherwise a category glyph in a tinted box.
export function FnIcon({ fn, size = 18 }: { fn: { logo: string | null; providerName: string; category: string }; size?: number }) {
  if (fn.logo) return <BrandIcon logo={fn.logo} name={fn.providerName} size={size} />;
  const glyph = CATEGORY_ICON[fn.category];
  if (!glyph) return <BrandIcon logo={null} name={fn.providerName} size={size} />;
  return <span className="fn-cat-icon" style={{ width: size, height: size }}>{glyph}</span>;
}

/** Flatten the connector catalog into a `"provider.method"` → {@link ColumnMeta}
 *  lookup for the grid headers. Includes the synthetic `"code"` key the server
 *  reports for agent-written custom-code columns. */
export function buildColumnMetaMap(connectors: ConnectorInfo[]): Map<string, ColumnMeta> {
  const map = new Map<string, ColumnMeta>();
  for (const c of connectors) {
    for (const m of c.methods) {
      const required = (m.input as { required?: unknown } | null | undefined)?.required;
      map.set(`${c.provider}.${m.method}`, {
        providerName: c.name,
        logo: c.logo ?? null,
        methodLabel: m.label || m.method,
        category: categorize(c.provider, m.category),
        credits: m.credits,
        requiredInputs: Array.isArray(required) ? required.map(String) : undefined,
      });
    }
  }
  map.set("code", { providerName: "Code", logo: null, methodLabel: "code", category: "Code" });
  return map;
}
