/**
 * Provider-credential → env-var injection for spawned agent sessions.
 *
 * Agent skills shell out to provider CLIs (trigify-cli, gh, …) that
 * authenticate via conventional env vars (`TRIGIFY_API_KEY`, `GITHUB_TOKEN`).
 * In LOCAL mode those vars only exist if the user exported them; in CLOUD mode
 * the key lives in the workspace credential store and never reaches the CLI.
 * These helpers resolve the saved credentials for whichever mode is active and
 * render them as an env map the agent spawn merges in — with the user's own
 * `process.env` always taking precedence, so an explicitly exported var keeps
 * winning exactly as before.
 *
 * Security: values are PLAINTEXT secrets. They ride the spawned child's env
 * only (the same channel as `GTMGRID_TOKEN`) and must never be logged.
 */

/**
 * Conventional env-var name for one secret entry of a connector:
 * upper-snake extension id + upper-snake secret key, deduped when the key is
 * already a suffix. Matches the ecosystem conventions the provider CLIs use:
 *   ("trigify", "apiKey") → TRIGIFY_API_KEY
 *   ("github", "token")   → GITHUB_TOKEN
 *   ("supabase", "url")   → SUPABASE_URL
 *   ("ai:openai", "apiKey") → AI_OPENAI_API_KEY
 */
export function envKeyFor(extensionId: string, secretKey: string): string {
  const snake = (s: string) =>
    s
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
  const id = snake(extensionId);
  const key = snake(secretKey);
  return id.endsWith(`_${key}`) || id === key ? id : `${id}_${key}`;
}

/**
 * Extra env names some provider CLIs read INSTEAD of the convention —
 * `extensionId → secretKey → additional names`. Both the conventional name and
 * the aliases are emitted; only add VERIFIED CLI conventions here.
 */
const ENV_ALIASES: Record<string, Record<string, readonly string[]>> = {
  github: { token: ["GH_TOKEN"] }, // `gh` reads GH_TOKEN (preferred) or GITHUB_TOKEN
  apify: { apiKey: ["APIFY_TOKEN"] }, // apify-cli/SDK read APIFY_TOKEN
};

/** Render one connector's plaintext secret map as env entries (blank values skipped). */
export function providerEnvFromSecrets(
  extensionId: string,
  secrets: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(secrets)) {
    if (typeof value !== "string" || value.trim() === "") continue;
    env[envKeyFor(extensionId, key)] = value;
    for (const alias of ENV_ALIASES[extensionId]?.[key] ?? []) env[alias] = value;
  }
  return env;
}

/**
 * LOCAL mode: env from the locally saved (SQLite, per-machine-key encrypted)
 * credentials of every registered connector. `getSecrets` is the local Db's
 * decrypt-on-read lookup; connectors without a saved credential are skipped.
 */
export function localProviderEnv(
  extensionIds: readonly string[],
  getSecrets: (extensionId: string) => Record<string, string> | null | undefined,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const id of extensionIds) {
    const secrets = getSecrets(id);
    if (secrets) Object.assign(env, providerEnvFromSecrets(id, secrets));
  }
  return env;
}

/** The slice of the agent cloud context the resolver needs. */
export interface ProviderEnvCloud {
  readonly apiUrl: string;
  readonly token: string;
  readonly workspaceId: string;
}

/** Metadata row shape of `credentials.list` (see CredentialMetadata in services). */
interface MetadataRow {
  readonly extensionId: string;
  readonly scope: "workspace" | "personal";
}

const isMetadataRow = (r: unknown): r is MetadataRow =>
  typeof r === "object" &&
  r !== null &&
  typeof (r as { extensionId?: unknown }).extensionId === "string" &&
  ((r as { scope?: unknown }).scope === "workspace" || (r as { scope?: unknown }).scope === "personal");

/** Read a tRPC envelope's `result.data` as `unknown` (mirrors cloud-push.ts). */
const readData = (raw: unknown): unknown =>
  typeof raw === "object" && raw !== null && "result" in raw && typeof raw.result === "object" && raw.result !== null && "data" in raw.result
    ? raw.result.data
    : undefined;

/**
 * CLOUD mode: env from the workspace credential store, resolved with the
 * member's bearer via the same tRPC procedures the web app uses —
 * `credentials.list` (metadata: which connectors are connected) then
 * `credentials.getForRun` per row (the member-gated decrypt). A personal key
 * overrides the shared workspace key for the same connector, matching the
 * engine's scope precedence.
 *
 * FAIL-OPEN: any error (network, auth, one row failing to decrypt) degrades to
 * fewer/no injected vars — it never blocks the agent from spawning. Errors are
 * logged WITHOUT values.
 */
export async function resolveCloudProviderEnv(cloud: ProviderEnvCloud): Promise<Record<string, string>> {
  const base = `${cloud.apiUrl.replace(/\/+$/, "")}/api/trpc`;
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${cloud.token}` };
  const query = async (operation: string, input: unknown): Promise<unknown> => {
    const res = await fetch(`${base}/${operation}?input=${encodeURIComponent(JSON.stringify(input))}`, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`${operation} → HTTP ${res.status}`);
    return readData(await res.json());
  };

  try {
    const raw = await query("credentials.list", { workspaceId: cloud.workspaceId });
    const rows = Array.isArray(raw) ? raw.filter(isMetadataRow) : [];
    // workspace rows first so a personal row for the same connector wins the
    // final merge (Object.assign in declaration order below).
    const ordered = [...rows.filter((r) => r.scope === "workspace"), ...rows.filter((r) => r.scope === "personal")];
    const fetched = await Promise.allSettled(
      ordered.map(async (row) => {
        const secrets = await query("credentials.getForRun", {
          workspaceId: cloud.workspaceId,
          extensionId: row.extensionId,
          scope: row.scope,
        });
        return { row, secrets };
      }),
    );
    const env: Record<string, string> = {};
    for (const result of fetched) {
      if (result.status !== "fulfilled") {
        console.warn(`[provider-env] credential fetch failed: ${String(result.reason)}`);
        continue;
      }
      const { row, secrets } = result.value;
      if (typeof secrets === "object" && secrets !== null && !Array.isArray(secrets)) {
        const map: Record<string, string> = {};
        for (const [k, v] of Object.entries(secrets)) if (typeof v === "string") map[k] = v;
        Object.assign(env, providerEnvFromSecrets(row.extensionId, map));
      }
    }
    return env;
  } catch (e) {
    console.warn(`[provider-env] cloud credential resolution failed: ${e instanceof Error ? e.message : String(e)}`);
    return {};
  }
}
