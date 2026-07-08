/**
 * The `/open` bounce page: HTTPS → `gtmgrid://` forwarding for email CTAs.
 *
 * SECURITY-SENSITIVE: the route reflects `?to=` into a protocol URL inside
 * HTML + a script tag, so the whitelist must be airtight — anything outside
 * the exact destination grammar degrades to the bare `gtmgrid://open`
 * (focus-the-app), never into markup or an attacker-shaped link.
 */

import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { GET } from "./route";

const WS = "11111111-1111-1111-1111-111111111111";
const TABLE = "22222222-2222-2222-2222-222222222222";

async function bounce(query: string): Promise<string> {
  const res = GET(new NextRequest(`https://www.gtmgrid.dev/open${query}`));
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/html");
  return await res.text();
}

/** The deep link the page will fire (from the redirect script). */
function firedLink(html: string): string {
  const m = html.match(/location\.href="([^"]*)"/);
  return m?.[1] ?? "";
}

describe("/open — whitelisted destinations", () => {
  it("no params → bare focus link", async () => {
    expect(firedLink(await bounce(""))).toBe("gtmgrid://open");
  });

  it("table/<uuid> with workspace", async () => {
    expect(
      firedLink(await bounce(`?to=${encodeURIComponent(`table/${TABLE}`)}&workspace=${WS}`)),
    ).toBe(`gtmgrid://open/table/${TABLE}?workspace=${WS}`);
  });

  it("each static destination round-trips", async () => {
    for (const dest of ["new-table", "settings/ai-providers", "invite", "members", "billing", "crm-connected"]) {
      expect(firedLink(await bounce(`?to=${encodeURIComponent(dest)}`))).toBe(
        `gtmgrid://open/${dest}`,
      );
    }
  });

  it("crm-connected carries a valid provider", async () => {
    expect(firedLink(await bounce(`?to=crm-connected&provider=hubspot`))).toBe(
      "gtmgrid://open/crm-connected?provider=hubspot",
    );
  });

  it("drops an invalid provider, and provider on any other destination", async () => {
    expect(firedLink(await bounce(`?to=crm-connected&provider=Bad%20One`))).toBe(
      "gtmgrid://open/crm-connected",
    );
    expect(firedLink(await bounce(`?to=billing&provider=hubspot`))).toBe(
      "gtmgrid://open/billing",
    );
  });
});

describe("/open — rejection paths (degrade to bare open, never reflect)", () => {
  it.each([
    ["path traversal", "../../etc/passwd"],
    ["unknown destination", "admin"],
    ["table with non-uuid id", "table/1;rm -rf"],
    ["script injection attempt", '"></script><script>alert(1)</script>'],
    ["protocol smuggling", "table/x?y=gtmgrid://evil"],
    ["nested destination", "billing/extra"],
  ])("%s → bare gtmgrid://open", async (_label, to) => {
    const html = await bounce(`?to=${encodeURIComponent(to)}`);
    expect(firedLink(html)).toBe("gtmgrid://open");
    // Raw payload never appears outside safe encoding.
    expect(html).not.toContain("<script>alert");
  });

  it("workspace param is dropped when invalid, and without a destination", async () => {
    expect(firedLink(await bounce(`?to=billing&workspace=not-a-uuid`))).toBe(
      "gtmgrid://open/billing",
    );
    expect(firedLink(await bounce(`?workspace=${WS}`))).toBe("gtmgrid://open");
  });
});
