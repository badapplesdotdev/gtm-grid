/**
 * Provider-env injection tests — all offline.
 *
 *   1. {@link envKeyFor} / {@link providerEnvFromSecrets} — the env-var naming
 *      convention provider CLIs expect (TRIGIFY_API_KEY, GITHUB_TOKEN, …).
 *   2. {@link localProviderEnv} — composes connected connectors, skips the rest.
 *   3. {@link resolveCloudProviderEnv} — a scripted global `fetch` proves the
 *      member-token tRPC flow (credentials.list → credentials.getForRun per
 *      row), personal-over-workspace precedence, and the FAIL-OPEN contract:
 *      a list failure yields `{}`, a single row failure drops only that row.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  envKeyFor,
  localProviderEnv,
  providerEnvFromSecrets,
  resolveCloudProviderEnv,
} from "./provider-env.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("envKeyFor", () => {
  it("maps the ecosystem CLI conventions", () => {
    expect(envKeyFor("trigify", "apiKey")).toBe("TRIGIFY_API_KEY");
    expect(envKeyFor("github", "token")).toBe("GITHUB_TOKEN");
    expect(envKeyFor("exa", "apiKey")).toBe("EXA_API_KEY");
    expect(envKeyFor("firecrawl", "apiKey")).toBe("FIRECRAWL_API_KEY");
    expect(envKeyFor("supabase", "url")).toBe("SUPABASE_URL");
  });

  it("snake-cases punctuated ids and camelCase keys", () => {
    expect(envKeyFor("ai:openai", "apiKey")).toBe("AI_OPENAI_API_KEY");
    expect(envKeyFor("thecompaniesapi", "apiToken")).toBe("THECOMPANIESAPI_API_TOKEN");
  });

  it("does not duplicate a key the id already ends with", () => {
    expect(envKeyFor("github_token", "token")).toBe("GITHUB_TOKEN");
  });
});

describe("providerEnvFromSecrets", () => {
  it("renders every non-blank secret entry", () => {
    expect(providerEnvFromSecrets("supabase", { url: "https://x.supabase.co", apiKey: "sk-1" })).toEqual({
      SUPABASE_URL: "https://x.supabase.co",
      SUPABASE_API_KEY: "sk-1",
    });
  });

  it("skips blank values", () => {
    expect(providerEnvFromSecrets("trigify", { apiKey: "  " })).toEqual({});
  });

  it("emits verified CLI aliases alongside the convention", () => {
    expect(providerEnvFromSecrets("github", { token: "gh-1" })).toEqual({ GITHUB_TOKEN: "gh-1", GH_TOKEN: "gh-1" });
    expect(providerEnvFromSecrets("apify", { apiKey: "ap-1" })).toEqual({ APIFY_API_KEY: "ap-1", APIFY_TOKEN: "ap-1" });
  });
});

describe("localProviderEnv", () => {
  it("composes connected connectors and skips ones without a credential", () => {
    const secretsByExt: Record<string, Record<string, string>> = {
      trigify: { apiKey: "tk-1" },
      github: { token: "gh-1" },
    };
    const env = localProviderEnv(["trigify", "github", "exa"], (id) => secretsByExt[id] ?? null);
    expect(env).toEqual({ TRIGIFY_API_KEY: "tk-1", GITHUB_TOKEN: "gh-1", GH_TOKEN: "gh-1" });
  });
});

/** Build a tRPC GET envelope response. */
const trpcOk = (data: unknown) =>
  new Response(JSON.stringify({ result: { data } }), { status: 200 });

const CLOUD = { apiUrl: "https://app.example.com/", token: "bearer-1", workspaceId: "ws-1" };

/** Parse the operation + input out of a recorded fetch URL. */
const parseCall = (url: string) => {
  const u = new URL(url);
  const operation = u.pathname.replace("/api/trpc/", "");
  const input = JSON.parse(decodeURIComponent(u.searchParams.get("input") ?? "null")) as unknown;
  return { operation, input };
};

describe("resolveCloudProviderEnv", () => {
  it("lists, decrypts each row via getForRun, and lets a personal key override the workspace key", async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const s = String(url);
      calls.push(s);
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer bearer-1");
      const { operation, input } = parseCall(s);
      if (operation === "credentials.list") {
        return trpcOk([
          { id: "1", extensionId: "trigify", scope: "personal", name: "t", ownerUserId: "u1", createdAt: 1 },
          { id: "2", extensionId: "trigify", scope: "workspace", name: "t", ownerUserId: null, createdAt: 1 },
          { id: "3", extensionId: "github", scope: "workspace", name: "g", ownerUserId: null, createdAt: 1 },
        ]);
      }
      const { extensionId, scope } = input as { extensionId: string; scope: string };
      if (extensionId === "trigify") return trpcOk({ apiKey: scope === "personal" ? "tk-personal" : "tk-shared" });
      return trpcOk({ token: "gh-1" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const env = await resolveCloudProviderEnv(CLOUD);
    expect(env).toEqual({ TRIGIFY_API_KEY: "tk-personal", GITHUB_TOKEN: "gh-1", GH_TOKEN: "gh-1" });
    // 1 list + 3 getForRun; trailing slash on apiUrl is trimmed.
    expect(calls).toHaveLength(4);
    expect(calls[0]).toContain("https://app.example.com/api/trpc/credentials.list");
  });

  it("fails open to {} when the list call fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 401 })));
    await expect(resolveCloudProviderEnv(CLOUD)).resolves.toEqual({});
  });

  it("drops only the failing row when one getForRun errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL) => {
        const { operation, input } = parseCall(String(url));
        if (operation === "credentials.list") {
          return trpcOk([
            { id: "1", extensionId: "trigify", scope: "workspace", name: "t", ownerUserId: null, createdAt: 1 },
            { id: "2", extensionId: "github", scope: "workspace", name: "g", ownerUserId: null, createdAt: 1 },
          ]);
        }
        const { extensionId } = input as { extensionId: string };
        if (extensionId === "github") return new Response("boom", { status: 500 });
        return trpcOk({ apiKey: "tk-1" });
      }),
    );
    const env = await resolveCloudProviderEnv(CLOUD);
    expect(env).toEqual({ TRIGIFY_API_KEY: "tk-1" });
  });

  it("ignores malformed rows and a null getForRun result", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL) => {
        const { operation } = parseCall(String(url));
        if (operation === "credentials.list") {
          return trpcOk([{ nonsense: true }, { id: "1", extensionId: "trigify", scope: "workspace", name: "t", ownerUserId: null, createdAt: 1 }]);
        }
        return trpcOk(null); // no matching credential
      }),
    );
    await expect(resolveCloudProviderEnv(CLOUD)).resolves.toEqual({});
  });
});
