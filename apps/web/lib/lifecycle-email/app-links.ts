/**
 * Deep-link URL builder for lifecycle-email CTAs.
 *
 * Every CTA points at the HTTPS bounce page (`apps/web/app/open/route.ts`)
 * rather than a raw `gtmgrid://` link (email clients strip custom schemes).
 * The bounce page whitelists the destination and forwards to
 * `gtmgrid://open/<dest>` with a download fallback, and the desktop router
 * (packages/desktop/src/cloud/deepLinkNav.ts) navigates in-app.
 *
 * Keep `AppDestination` in sync with the bounce whitelist + desktop grammar.
 */

export type AppDestination =
  | { readonly kind: "app" } // just open/focus
  | { readonly kind: "table"; readonly tableId: string; readonly workspaceId?: string }
  | { readonly kind: "new-table" }
  | { readonly kind: "ai-providers" }
  | { readonly kind: "invite" }
  | { readonly kind: "members" }
  | { readonly kind: "billing" };

function siteOrigin(): string {
  return process.env.SITE_URL ?? "https://www.gtmgrid.dev";
}

/** Absolute HTTPS URL for an email CTA that deep-links into the app. */
export function appOpenUrl(dest: AppDestination = { kind: "app" }): string {
  const base = `${siteOrigin()}/open`;
  switch (dest.kind) {
    case "app":
      return base;
    case "table": {
      const ws = dest.workspaceId
        ? `&workspace=${encodeURIComponent(dest.workspaceId)}`
        : "";
      return `${base}?to=${encodeURIComponent(`table/${dest.tableId}`)}${ws}`;
    }
    case "new-table":
      return `${base}?to=new-table`;
    case "ai-providers":
      return `${base}?to=${encodeURIComponent("settings/ai-providers")}`;
    case "invite":
      return `${base}?to=invite`;
    case "members":
      return `${base}?to=members`;
    case "billing":
      return `${base}?to=billing`;
  }
}
