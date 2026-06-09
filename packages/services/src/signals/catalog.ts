// Shared Trigify "social signals" catalog + result mapping, used by the cloud
// tRPC layer and the Inngest cron worker. This is the cloud-side counterpart of
// packages/server/src/signals.ts (the desktop sidecar's copy) — the source list,
// REST paths, column mapping and result-field extraction MUST stay in sync.
//
// Pure functions only (no Effect / db / fetch) so it can be imported anywhere.

export const TRIGIFY_BASE = "https://api.trigify.io";

export type SignalSchedule = "manual" | "hourly" | "daily" | "weekly";
export type SignalKind = "search" | "profileEngagement";

export interface SignalColumn {
  /** Result field path(s), "a.b|c.d" tried in order; "__name" = author name. */
  key: string;
  /** Column name created in the table. */
  name: string;
}

export interface SignalSource {
  id: string;
  label: string;
  group: string;
  kind: SignalKind;
  /** Trigify REST path that CREATES the search/monitor (POST). */
  createPath: string;
  /** Path template that FETCHES results — `{id}` is the search id (GET). */
  resultsPath: string;
  columns: SignalColumn[];
  /** Minimal JSON-schema of the config the create form collects (cloud UI). */
  inputSchema: { type: "object"; required: string[]; properties: Record<string, unknown> };
}

// Scan settings shared by every source (look-back / limit / scan frequency).
const SCAN_PROPS: Record<string, unknown> = {
  time_frame: { type: "string", description: "past-24h | past-week | past-month | past-6-months | past-year | all-time" },
  max_results: { type: "number", description: "10-100" },
  frequency: { type: "string", description: "hourly | every-12h | daily | weekly | monthly | quarterly" },
};
// Keyword (Boolean) post searches → OR/AND/NOT builder.
const KEYWORD_SCHEMA = {
  type: "object" as const,
  required: ["keywords"],
  properties: {
    keywords: { type: "array", items: { type: "string" }, description: "Match ANY of these (OR)" },
    keywords_and: { type: "array", items: { type: "string" }, description: "Must also include (AND)" },
    keywords_not: { type: "array", items: { type: "string" }, description: "Exclude (NOT)" },
    ...SCAN_PROPS,
  },
};
// Profile / channel monitors → a single profile URL.
const PROFILE_SCHEMA = {
  type: "object" as const,
  required: ["profile_url"],
  properties: {
    profile_url: { type: "string", description: "Profile / channel / publication URL" },
    ...SCAN_PROPS,
  },
};

// People-who-posted (post sources + profile monitors) vs engagers.
const POST_COLUMNS: SignalColumn[] = [
  { key: "__name", name: "Name" },
  { key: "author.profile_url|author.url|author.username|author.handle", name: "Profile URL" },
  { key: "content.text|content.body|content.title|text", name: "Post" },
  { key: "content.url|content.permalink|url|link", name: "Post URL" },
  { key: "published_at|created_at|date", name: "Posted At" },
  { key: "engagement.likes|engagement.upvotes|engagement.reactions|likes", name: "Likes" },
  { key: "engagement.comments|engagement.replies|comments", name: "Comments" },
];
const ENGAGE_COLUMNS: SignalColumn[] = [
  { key: "__name", name: "Name" },
  { key: "author.profile_url|author.url|profile_url", name: "Profile URL" },
  { key: "reaction_type|engagement_type|type", name: "Engagement" },
  { key: "content.url|post.url|url", name: "Post URL" },
  { key: "published_at|created_at|date", name: "Date" },
];

const RESULTS = "/v1/searches/{id}/results";
const post = (id: string, label: string, group: string, createPath: string): SignalSource => ({
  id,
  label,
  group,
  kind: "search",
  createPath,
  resultsPath: RESULTS,
  columns: POST_COLUMNS,
  inputSchema: group === "Profile & company" ? PROFILE_SCHEMA : KEYWORD_SCHEMA,
});

export const SIGNAL_SOURCES: SignalSource[] = [
  // Posts & keywords
  post("linkedin-posts", "LinkedIn Posts", "Posts & keywords", "/v1/searches/linkedin/posts"),
  post("x-mentions", "X Mentions", "Posts & keywords", "/v1/searches/twitter/posts"),
  post("reddit-posts", "Reddit Posts", "Posts & keywords", "/v1/searches/reddit/posts"),
  post("subreddit", "Subreddit Monitor", "Posts & keywords", "/v1/searches/reddit/subreddit"),
  post("substack-posts", "Substack Posts", "Posts & keywords", "/v1/searches/substack/posts"),
  post("youtube-videos", "YouTube Videos", "Posts & keywords", "/v1/searches/youtube/videos"),
  post("bluesky-posts", "Bluesky Posts", "Posts & keywords", "/v1/searches/bluesky/posts"),
  post("hackernews", "Hacker News Stories", "Posts & keywords", "/v1/searches/hackernews/stories"),
  post("github-issues", "GitHub Issues", "Posts & keywords", "/v1/searches/github/issues"),
  post("github-discussions", "GitHub Discussions", "Posts & keywords", "/v1/searches/github/discussions"),
  post("news", "News Articles", "Posts & keywords", "/v1/searches/newsapi-ai/posts"),
  post("dailydev", "Daily.dev Posts", "Posts & keywords", "/v1/searches/dailydev/posts"),
  post("podcast-keywords", "Podcast Keywords", "Posts & keywords", "/v1/searches/podcast/keywords"),
  // Profile & company monitors
  post("linkedin-profile", "LinkedIn Profile / Company", "Profile & company", "/v1/searches/linkedin/profile"),
  post("x-profile", "X Profile", "Profile & company", "/v1/searches/twitter/profile"),
  post("youtube-channel", "YouTube Channel", "Profile & company", "/v1/searches/youtube/channel"),
  post("substack-profile", "Substack Publication", "Profile & company", "/v1/searches/substack/profile"),
  post("bluesky-profile", "Bluesky Profile", "Profile & company", "/v1/searches/bluesky/profile"),
  post("podcast-episodes", "Podcast Episodes", "Profile & company", "/v1/searches/podcast/episodes"),
  // Engagement
  {
    id: "profile-engagement",
    label: "Profile Engagement",
    group: "Engagement",
    kind: "profileEngagement",
    createPath: "/v1/profile/engagement/bulk",
    resultsPath: "/v1/profile/engagement/results",
    columns: ENGAGE_COLUMNS,
    inputSchema: {
      type: "object",
      required: ["profile_urls"],
      properties: {
        profile_urls: { type: "array", items: { type: "string" }, description: "LinkedIn profile URLs to track engagement on" },
        ...SCAN_PROPS,
      },
    },
  },
];

export function getSignalSource(id: string): SignalSource | undefined {
  return SIGNAL_SOURCES.find((s) => s.id === id);
}

// ── Result-field extraction (identical to the sidecar) ───────────
function getOne(obj: any, path: string): unknown {
  if (path === "__name") {
    return (
      obj?.author?.name ||
      obj?.name ||
      [obj?.first_name, obj?.last_name].filter(Boolean).join(" ") ||
      obj?.full_name ||
      obj?.author?.username ||
      ""
    );
  }
  return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/** First non-empty value across `a.b|c.d` fallback paths. */
export function getPath(obj: any, key: string): unknown {
  for (const p of key.split("|")) {
    const v = getOne(obj, p.trim());
    if (v != null && v !== "") return v;
  }
  return undefined;
}

/** Stable-ish dedupe key for a result row. */
export function resultKey(r: any): string {
  return String(
    r?.id ??
      r?.post?.id ??
      r?.post?.url ??
      r?.url ??
      `${getPath(r, "author.profile_url") ?? ""}|${getPath(r, "published_at|created_at") ?? ""}`,
  );
}

/** Normalize the Trigify results response (array, {results}, {data}, …) to an array. */
export function normalizeResults(resp: any): any[] {
  if (Array.isArray(resp)) return resp;
  return resp?.results ?? resp?.data ?? resp?.items ?? resp?.profiles ?? [];
}

export function toCellValue(v: unknown): unknown {
  if (v == null) return "";
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  return JSON.stringify(v);
}

/** Map one Trigify result into a `{ columnName: value }` object. */
export function mapResultToCells(result: any, columns: SignalColumn[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const col of columns) {
    const v = toCellValue(getPath(result, col.key));
    if (v !== "") out[col.name] = v;
  }
  return out;
}

/**
 * Minimum elapsed time (ms) since the last sync before a non-manual binding is
 * due again, keyed by schedule. Exported so the repo can push the same predicate
 * down into SQL (`now - last_synced_at >= interval`) instead of loading every
 * binding and re-checking in JS.
 */
export const SCHEDULE_DUE_MS: Record<Exclude<SignalSchedule, "manual">, number> = {
  hourly: 60 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
};

/** True when an enabled, non-manual binding is due for another poll. */
export function isBindingDue(
  b: { enabled: boolean; schedule: SignalSchedule; lastSyncedAt: number | null },
  now: number,
): boolean {
  if (!b.enabled || b.schedule === "manual") return false;
  if (b.lastSyncedAt == null) return true;
  if (b.schedule === "hourly" || b.schedule === "daily" || b.schedule === "weekly") {
    return now - b.lastSyncedAt >= SCHEDULE_DUE_MS[b.schedule];
  }
  // Unknown/legacy schedule string: treat as never due (matches the old map
  // lookup, which would have produced NaN >= comparison === false).
  return false;
}

/** A cap on results processed per poll, so one binding can't enqueue an
 * unbounded payload of inserts in a single step. */
export const MAX_RESULTS_PER_SYNC = 500;

/** How many due bindings to enqueue per fan-out event/step. */
export const FANOUT_CHUNK = 200;

/** How many due bindings the cron pulls per keyset page. */
export const DUE_PAGE_SIZE = 500;
