// Render the branded NSIS installer images (sidebar + header) from their SVG
// sources to the 24-bit BMPs electron-builder/NSIS expect. Run as part of the
// Windows packaging step. Requires `rsvg-convert` (SVG→PNG) + `sips` (PNG→BMP) on
// the build host; on a Windows CI runner swap in any SVG→BMP tool of choice.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const res = resolve(dirname(fileURLToPath(import.meta.url)), "..", "build-resources");
const tmp = mkdtempSync(join(tmpdir(), "gtmgrid-installer-"));

const assets = [
  { svg: "installer-sidebar.svg", bmp: "installerSidebar.bmp", w: 164, h: 314 },
  { svg: "installer-header.svg", bmp: "installerHeader.bmp", w: 150, h: 57 },
];

try {
  for (const a of assets) {
    const png = join(tmp, a.bmp.replace(/\.bmp$/, ".png"));
    execFileSync("rsvg-convert", ["-w", String(a.w), "-h", String(a.h), join(res, a.svg), "-o", png]);
    execFileSync("sips", ["-s", "format", "bmp", png, "--out", join(res, a.bmp)], { stdio: "ignore" });
    if (!existsSync(join(res, a.bmp))) throw new Error(`failed to produce ${a.bmp}`);
    console.log(`installer asset: ${a.bmp} (${a.w}x${a.h})`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
