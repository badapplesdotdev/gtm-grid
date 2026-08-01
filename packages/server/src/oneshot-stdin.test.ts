// Regression test for the no-BYO-key AI fallback: `generateWithAgent` spawns the
// user's local `claude` CLI for one-shot text generation. The prompt is passed via
// `-p`, so the CLI must NOT be left waiting on stdin — otherwise it prints
// "no stdin data received in 3s, proceeding without it" and (in the bug) returned
// empty stdout, which surfaced as a blocking `claude: <warning>` error on the
// default onboarding path. The fix closes the child's stdin. We prove it with a
// fake `claude` that only emits its JSON result AFTER stdin hits EOF: if stdin were
// left open it would block until the spawn timeout, failing this test.

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

const HOME = mkdtempSync(join(tmpdir(), "gtmgrid-oneshot-"));
vi.mock("node:os", async (orig) => {
  const actual = await orig<typeof import("node:os")>();
  return { ...actual, homedir: () => HOME };
});

// Imported after the mock so CONFIG_DIR (computed at module load) uses temp HOME.
const { generateWithAgent, setAgentPath } = await import("./agent.js");

// A fake `claude` that blocks on `cat` until stdin EOF, then emits the JSON
// envelope real claude produces for `--output-format json`.
const fakeClaude = join(HOME, "claude");
writeFileSync(
  fakeClaude,
  '#!/bin/sh\ncat >/dev/null\necho \'{"result":"hi from fake claude","is_error":false}\'\n',
);
chmodSync(fakeClaude, 0o755);

afterAll(() => {
  setAgentPath("claude", null);
  rmSync(HOME, { recursive: true, force: true });
});

describe("generateWithAgent — one-shot claude fallback closes stdin", () => {
  it("resolves with the model text instead of blocking on stdin", async () => {
    setAgentPath("claude", fakeClaude);
    const result = await generateWithAgent("do a thing", "be terse");
    expect(result).toEqual({ text: "hi from fake claude" });
  }, 20_000);
});
