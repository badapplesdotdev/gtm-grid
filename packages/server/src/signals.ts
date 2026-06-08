// "From Signals" — bind a local table to a Trigify saved search (or profile
// engagement monitor) and pull new results into rows on a schedule. The sidecar
// only runs while the app is open, so we use a poll-while-open model plus a
// catch-up sync on boot / project switch (pull everything new since lastSyncedAt).
//
// Bindings are stored per-project in the project db `meta` table (JSON array
// under "signal_bindings") — no schema migration needed.

import { randomUUID } from "node:crypto";
import type { Db, Engine } from "@gtmgrid/engine";

export type SignalSchedule = "manual" | "hourly" | "daily" | "weekly";
export type SignalKind = "search" | "profileEngagement";

export interface SignalColumn {
  /** Result field path (dot notation), or "__name" for first+last name. */
  key: string;
  /** Column name created in the table. */
  name: string;
}

export interface SignalSource {
  id: string;
  label: string;
  group: string;
  kind: SignalKind;
  /** Trigify method that creates the search/monitor. */
  method: string;
  /** Trigify method that fetches results. */
  resultsMethod: string;
  description: string;
  /** Default columns created in the table + how to map result fields. */
  columns: SignalColumn[];
}

export interface SignalBinding {
  id: string;
  tableId: string;
  provider: "trigify";
  sourceId: string;
  label: string;
  kind: SignalKind;
  method: string;
  resultsMethod: string;
  /** The Trigify search id (kind="search"); null until created. */
  searchId: string | null;
  config: Record<string, unknown>;
  schedule: SignalSchedule;
  columns: SignalColumn[];
  lastSyncedAt: number | null;
  lastError: string | null;
  rowsPulled: number;
  /** Recently-seen result keys (capped) for cross-sync dedupe. */
  seen: string[];
  enabled: boolean;
  createdAt: number;
}

// ── Source catalog ────────────────────────────────────────────────
// Column sets: people who posted (post sources + profile monitors) vs engagers.
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

const post = (id: string, label: string, group: string, method: string): SignalSource => ({
  id,
  label,
  group,
  kind: "search",
  method,
  resultsMethod: "searchResults",
  description: "",
  columns: POST_COLUMNS,
});

export const SIGNAL_SOURCES: SignalSource[] = [
  // Posts & keywords
  post("linkedin-posts", "LinkedIn Posts", "Posts & keywords", "createLinkedInPostsSearch"),
  post("x-mentions", "X Mentions", "Posts & keywords", "createTwitterPostsSearch"),
  post("reddit-posts", "Reddit Posts", "Posts & keywords", "createRedditPostsSearch"),
  post("subreddit", "Subreddit Monitor", "Posts & keywords", "createSubredditPostsSearch"),
  post("substack-posts", "Substack Posts", "Posts & keywords", "createSubstackPostsSearch"),
  post("youtube-videos", "YouTube Videos", "Posts & keywords", "createYouTubeVideosSearch"),
  post("bluesky-posts", "Bluesky Posts", "Posts & keywords", "createBlueskyPostsSearch"),
  post("hackernews", "Hacker News Stories", "Posts & keywords", "createHackerNewsStoriesSearch"),
  post("github-issues", "GitHub Issues", "Posts & keywords", "createGitHubIssuesSearch"),
  post("github-discussions", "GitHub Discussions", "Posts & keywords", "createGitHubDiscussionsSearch"),
  post("news", "News Articles", "Posts & keywords", "createNewsApiAiPostsSearch"),
  post("dailydev", "Daily.dev Posts", "Posts & keywords", "createDailyDevPostsSearch"),
  post("podcast-keywords", "Podcast Keywords", "Posts & keywords", "createPodcastKeywordsSearch"),
  // Profile & company monitors
  post("linkedin-profile", "LinkedIn Profile / Company", "Profile & company", "createLinkedInProfileSearch"),
  post("x-profile", "X Profile", "Profile & company", "createTwitterProfileSearch"),
  post("youtube-channel", "YouTube Channel", "Profile & company", "createYouTubeChannelSearch"),
  post("substack-profile", "Substack Publication", "Profile & company", "createSubstackProfileSearch"),
  post("bluesky-profile", "Bluesky Profile", "Profile & company", "createBlueskyProfileSearch"),
  post("podcast-episodes", "Podcast Episodes", "Profile & company", "createPodcastEpisodesSearch"),
  // Engagement
  {
    id: "profile-engagement",
    label: "Profile Engagement",
    group: "Engagement",
    kind: "profileEngagement",
    method: "profileEngagementBulk",
    resultsMethod: "profileEngagementResults",
    description: "Track LinkedIn profiles and pull everyone who likes/comments on their posts.",
    columns: ENGAGE_COLUMNS,
  },
];

export function getSource(id: string): SignalSource | undefined {
  return SIGNAL_SOURCES.find((s) => s.id === id);
}

// ── Bindings store (project db meta) ──────────────────────────────
const META_KEY = "signal_bindings";

export function listBindings(projectDb: Db): SignalBinding[] {
  try {
    const raw = projectDb.getMeta(META_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function saveBindings(projectDb: Db, bindings: SignalBinding[]): void {
  projectDb.setMeta(META_KEY, JSON.stringify(bindings));
}

export function upsertBinding(projectDb: Db, binding: SignalBinding): void {
  const all = listBindings(projectDb);
  const i = all.findIndex((b) => b.id === binding.id);
  if (i >= 0) all[i] = binding;
  else all.push(binding);
  saveBindings(projectDb, all);
}

export function deleteBinding(projectDb: Db, id: string): boolean {
  const all = listBindings(projectDb);
  const next = all.filter((b) => b.id !== id);
  if (next.length === all.length) return false;
  saveBindings(projectDb, next);
  return true;
}

// ── Result field extraction ───────────────────────────────────────
function getOne(obj: any, path: string): unknown {
  if (path === "__name") {
    return obj?.author?.name || obj?.name || [obj?.first_name, obj?.last_name].filter(Boolean).join(" ") || obj?.full_name || obj?.author?.username || "";
  }
  return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
/** Resolve the first non-empty value across `a.b|c.d` fallback paths — different
 *  Trigify sources (LinkedIn, Reddit, X, …) shape fields slightly differently. */
function getPath(obj: any, key: string): unknown {
  for (const p of key.split("|")) {
    const v = getOne(obj, p.trim());
    if (v != null && v !== "") return v;
  }
  return undefined;
}

/** A stable-ish dedupe key for a result row. */
function resultKey(r: any): string {
  return String(
    r?.id ??
      r?.post?.id ??
      r?.post?.url ??
      r?.url ??
      `${getPath(r, "linkedin_url") ?? ""}|${getPath(r, "post.created_at") ?? getPath(r, "created_at") ?? ""}`,
  );
}

function normalizeResults(resp: any): any[] {
  if (Array.isArray(resp)) return resp;
  return resp?.results ?? resp?.data ?? resp?.items ?? resp?.profiles ?? [];
}

function toCellValue(v: unknown): unknown {
  if (v == null) return "";
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  return JSON.stringify(v);
}

// ── Sync ──────────────────────────────────────────────────────────
export interface SignalDeps {
  /** Dispatch a connector method host-side (engine.dispatch). */
  dispatch: (provider: string, method: string, input: Record<string, unknown>) => Promise<unknown>;
  projectDb: Db;
}

const SEEN_CAP = 1000;

/** Pull new results for one binding into its table. Never throws — records lastError. */
export async function syncBinding(deps: SignalDeps, binding: SignalBinding): Promise<{ added: number; error?: string }> {
  const { dispatch, projectDb } = deps;
  try {
    if (binding.kind === "search" && !binding.searchId) {
      throw new Error("search not created yet");
    }
    // NOTE: do NOT pass `from` — Trigify filters by the post's PUBLISH date, so a
    // since-last-sync window would drop posts that were just collected but published
    // earlier. Dedupe is handled entirely by the `seen` keys below.
    const input: Record<string, unknown> = { limit: 100 };
    if (binding.kind === "search") input.id = binding.searchId;
    else input.config = binding.config; // profile engagement results keyed by tracked set

    const resp = await dispatch("trigify", binding.resultsMethod, input);
    const results = normalizeResults(resp);

    // Map table column names → ids for this table.
    const cols = projectDb.listColumns(binding.tableId);
    const idByName = new Map(cols.map((c) => [c.name, c.id]));

    const seen = new Set(binding.seen ?? []);
    const fresh = results.filter((r) => {
      const k = resultKey(r);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    let added = 0;
    if (fresh.length) {
      const insert = projectDb.raw.transaction((rows: any[]) => {
        for (const r of rows) {
          const row = projectDb.createRow(binding.tableId);
          for (const col of binding.columns) {
            const colId = idByName.get(col.name);
            if (!colId) continue;
            const val = toCellValue(getPath(r, col.key));
            if (val === "") continue;
            projectDb.setCell(row.id, colId, { value: val, status: "done" });
          }
          added++;
        }
      });
      insert(fresh);
    }

    // Persist updated cursor + dedupe window.
    const updated: SignalBinding = {
      ...binding,
      lastSyncedAt: Date.now(),
      lastError: null,
      rowsPulled: binding.rowsPulled + added,
      seen: [...seen].slice(-SEEN_CAP),
    };
    upsertBinding(projectDb, updated);
    return { added };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    upsertBinding(projectDb, { ...binding, lastError: error, lastSyncedAt: binding.lastSyncedAt });
    return { added: 0, error };
  }
}

// ── Scheduling ────────────────────────────────────────────────────
const INTERVAL_MS: Record<Exclude<SignalSchedule, "manual">, number> = {
  hourly: 60 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
};

function isDue(b: SignalBinding, now: number): boolean {
  if (!b.enabled || b.schedule === "manual") return false;
  if (b.lastSyncedAt == null) return true;
  return now - b.lastSyncedAt >= INTERVAL_MS[b.schedule];
}

/**
 * After a search is created its results populate asynchronously (often 10-30s),
 * so the immediate pull can be empty. Retry a handful of times until rows land.
 * Fire-and-forget from the create route; writes straight to the project db.
 */
export async function warmUpBinding(deps: SignalDeps, bindingId: string, attempts = 30, delayMs = 12000): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    await new Promise((r) => setTimeout(r, delayMs));
    const b = listBindings(deps.projectDb).find((x) => x.id === bindingId);
    if (!b) return; // binding deleted — stop
    const { added } = await syncBinding(deps, b);
    if (added > 0) return; // results landed
  }
}

/** Sync every due binding in the given project. Used by the tick + catch-up. */
export async function syncDue(deps: SignalDeps): Promise<number> {
  const now = Date.now();
  const due = listBindings(deps.projectDb).filter((b) => isDue(b, now));
  let total = 0;
  for (const b of due) {
    const { added } = await syncBinding(deps, b);
    total += added;
  }
  return total;
}

/**
 * Start the poll-while-open loop. `getDeps` returns the CURRENT project's deps
 * each tick (so it follows project switches). Returns a stop function.
 */
export function startSignalPoller(getDeps: () => SignalDeps | null, tickMs = 5 * 60 * 1000): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const deps = getDeps();
      if (deps) await syncDue(deps);
    } catch {
      /* never let the poller crash the sidecar */
    } finally {
      running = false;
    }
  };
  const handle = setInterval(tick, tickMs);
  // Catch-up shortly after boot (let the project settle first).
  setTimeout(tick, 8000);
  return () => clearInterval(handle);
}

/** Build the default binding skeleton for a source (search id filled in after creation). */
export function newBinding(args: {
  tableId: string;
  source: SignalSource;
  config: Record<string, unknown>;
  schedule: SignalSchedule;
  searchId: string | null;
}): SignalBinding {
  return {
    id: randomUUID(),
    tableId: args.tableId,
    provider: "trigify",
    sourceId: args.source.id,
    label: args.source.label,
    kind: args.source.kind,
    method: args.source.method,
    resultsMethod: args.source.resultsMethod,
    searchId: args.searchId,
    config: args.config,
    schedule: args.schedule,
    columns: args.source.columns,
    lastSyncedAt: null,
    lastError: null,
    rowsPulled: 0,
    seen: [],
    enabled: true,
    createdAt: Date.now(),
  };
}
