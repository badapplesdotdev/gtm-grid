// Regression test for the cursor MCP-config security fix: unlike claude/codex
// (which keep the cloud member bearer on an ephemeral argv), cursor-agent has no
// inline MCP flag, so gtmgrid's env — including `GTMGRID_TOKEN` — is written to a
// file. That file MUST NOT be group/world-readable. We sandbox HOME to a temp dir
// so the test never touches the real ~/.gtmgrid.

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

const HOME = mkdtempSync(join(tmpdir(), "gtmgrid-cursor-sec-"));
vi.mock("node:os", async (orig) => {
  const actual = await orig<typeof import("node:os")>();
  return { ...actual, homedir: () => HOME };
});

// Imported after the mock so CONFIG_DIR (computed at module load) uses temp HOME.
const { writeCursorMcpConfig } = await import("./agent.js");

const cursorDir = join(HOME, ".gtmgrid", "cursor", ".cursor");
const configPath = join(cursorDir, "mcp.json");

afterAll(() => rmSync(HOME, { recursive: true, force: true }));

describe("writeCursorMcpConfig — on-disk token is owner-only", () => {
  it("writes the cloud token to a file with NO group/world permission bits", () => {
    const cloud = {
      apiUrl: "https://app.test",
      token: "secret-bearer-xyz",
      workspaceId: "ws_1",
      projectId: "proj_1",
      tableId: "tbl_1",
    };
    writeCursorMcpConfig("/repo", "proj", cloud);

    expect(existsSync(configPath)).toBe(true);
    // The token IS in the file — which is exactly why the perms matter.
    expect(readFileSync(configPath, "utf8")).toContain("secret-bearer-xyz");
    // 0600 file, 0700 dir → no group/other bits set (robust to umask).
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
    expect(statSync(cursorDir).mode & 0o077).toBe(0);
  });
});
