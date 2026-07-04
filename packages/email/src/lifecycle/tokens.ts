/**
 * Design tokens for the LIFECYCLE email system — ported from the Claude Design
 * "Product Email Activation Sequence" handoff (claude.ai/design project
 * `d11a91ae…`, `Lifecycle Emails.dc.html`, emails #8–#20).
 *
 * The lifecycle cards use the LIGHT chrome (white header bar with the color
 * brand icon + lowercase wordmark, `#fbfbfd` footer) — deliberately softer than
 * the dark-header transactional shell in ../templates.ts. Palette values match
 * the GTM Grid brand pack (Anymark DESIGN.md) and the constants already used by
 * the transactional templates, so the two systems stay visually coherent.
 */

/** Brand accent — green `color-700`, WCAG AA on white (CTA background). */
export const ACCENT = "#136d34";
/** CTA hover — brand `color-800`. */
export const ACCENT_HOVER = "#0b411f";

// Ink scale.
export const INK = "#111118";
export const INK_2 = "#5a5a6e";
export const INK_3 = "#9696a8";

// Surfaces + borders.
export const BORDER = "#e4e4ea";
export const HAIRLINE = "#f0f0f4";
export const CARD_HEADER_BORDER = "#eef0f2";
export const SURFACE = "#f8f8fa";
export const SURFACE_2 = "#f3f3f7";
export const FOOTER_BG = "#fbfbfd";
export const PAGE_BG = "#f8f8fa";

// Green tints (chips, function badges, highlight boxes).
export const GREEN_TINT = "#eafbf1";
export const GREEN_TINT_BORDER = "#bef4d2";

// Success (run-complete, "done"/"hot" chips).
export const SUCCESS = "#15803d";
export const SUCCESS_TINT = "#f0fdf4";
export const SUCCESS_TINT_BORDER = "#bbf0cd";

// Status accents.
export const WARNING = "#b45309";
export const DANGER = "#dc2626";

// Type stacks (DM Sans / JetBrains Mono, loaded by the shell's font link with
// system fallbacks — same stacks as ../templates.ts).
export const SANS =
  "'DM Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
export const MONO = "'JetBrains Mono','SF Mono',Menlo,Consolas,monospace";

/** Lowercase wordmark used in the lifecycle chrome (per the design cards). */
export const WORDMARK = "gtm grid";
/** Footer tagline (design footer, all cards). */
export const TAGLINE = "gtm grid — local-first spreadsheet for GTM teams";
/**
 * CAN-SPAM postal line for the footer. The design ships a sample address —
 * override with `EMAIL_POSTAL_ADDRESS` once the real registered address is set.
 */
export function postalAddress(): string {
  return (
    process.env.EMAIL_POSTAL_ADDRESS ??
    "gtm grid, inc. · 2261 Market St, San Francisco, CA 94114"
  );
}

/** Default web origin for footer/CTA links (override per-deploy). */
export function webOrigin(): string {
  return process.env.EMAIL_LINK_ORIGIN ?? "https://gtmgrid.dev";
}
