/**
 * Public share snapshot as JSON — `GET /api/share/<token>`.
 *
 * The machine-readable counterpart to the `/share/<token>` page: returns the
 * frozen, secret-free snapshot for a valid token, or 404 for a missing /
 * disabled / expired one. The MCP `import_table_from_share` tool fetches this to
 * rebuild the table in a recipient's project. No auth — the token IS the
 * capability. Never cached (a revoke/expiry must take effect immediately).
 *
 * Reuses the SAME in-process `loadSharePreview` the page uses (the public
 * `ShareService.getShareByToken` Effect), so there is one source of truth for
 * what a token resolves to.
 */

import { loadSharePreview } from "../../../../lib/share-preview";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const result = await loadSharePreview(token);
  const headers = { "Cache-Control": "no-store" };
  if (result.kind !== "ok" || !result.preview.valid) {
    return Response.json({ valid: false }, { status: 404, headers });
  }
  return Response.json(
    {
      valid: true,
      name: result.preview.name,
      snapshot: result.preview.snapshot,
    },
    { headers },
  );
}
