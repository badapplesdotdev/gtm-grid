/**
 * `/api/download/<platform>` — 302-redirects to the latest desktop installer for
 * the given platform, resolved from the newest GitHub release at request time
 * (so links never go stale across version bumps). `platform` is one of the
 * {@link PLATFORMS} keys (mac-arm, mac-intel, windows, linux, linux-deb).
 * Unknown platform or an unresolvable asset falls back to the releases page.
 */
import { NextResponse } from "next/server";
import { ALL_RELEASES_URL, assetUrlFor, platformByKey } from "@/lib/releases";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ platform: string }> },
) {
  const { platform } = await params;
  if (!platformByKey(platform)) {
    return NextResponse.redirect(ALL_RELEASES_URL, 302);
  }
  const url = await assetUrlFor(platform);
  return NextResponse.redirect(url, 302);
}
