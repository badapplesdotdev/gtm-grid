/**
 * `resolveSiteUrl` — the self-deployment base-URL resolution used by the
 * Inngest worker client and the webhook receiver. Explicit `SITE_URL` wins;
 * Vercel-injected hosts are the fallback so deployments work without manual
 * config; nothing available fails closed.
 */

import { describe, expect, it } from "vitest";
import { resolveSiteUrl } from "./site-url";

describe("resolveSiteUrl", () => {
  it("prefers an explicit SITE_URL and trims the trailing slash", () => {
    expect(
      resolveSiteUrl({ SITE_URL: "https://app.gtmgrid.io/", VERCEL_URL: "x.vercel.app" }),
    ).toBe("https://app.gtmgrid.io");
  });

  it("falls back to the Vercel production domain (https prefixed)", () => {
    expect(
      resolveSiteUrl({
        VERCEL_PROJECT_PRODUCTION_URL: "app.gtmgrid.io",
        VERCEL_URL: "gtm-grid-abc123.vercel.app",
      }),
    ).toBe("https://app.gtmgrid.io");
  });

  it("falls back to the per-deployment VERCEL_URL last", () => {
    expect(resolveSiteUrl({ VERCEL_URL: "gtm-grid-abc123.vercel.app" })).toBe(
      "https://gtm-grid-abc123.vercel.app",
    );
  });

  it("treats empty strings as unset", () => {
    expect(
      resolveSiteUrl({ SITE_URL: "", VERCEL_PROJECT_PRODUCTION_URL: "", VERCEL_URL: "x.vercel.app" }),
    ).toBe("https://x.vercel.app");
  });

  it("fails closed when nothing is available", () => {
    expect(() => resolveSiteUrl({})).toThrow(/SITE_URL is not configured/);
  });
});
