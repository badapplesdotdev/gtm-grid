/**
 * The provider-neutral CRM client seam (TRI: crm-sync). `CrmSyncService`
 * consumes ONLY this interface — each provider (AttioClient, HubspotClient)
 * implements it and `CrmClientRegistry` dispatches on `binding.provider`.
 *
 * Two deliberate design points:
 *
 * - **Records arrive pre-flattened.** Query methods take the `attrs`
 *   (slug + provider type) the caller cares about and return `CrmRecord`s
 *   whose values are already `FlatValue`s — Attio flattens its typed value
 *   entries, HubSpot wraps its flat property strings. The sync engine never
 *   sees a provider's raw value shapes.
 * - **Opaque cursor paging.** `CrmPage.nextCursor` accommodates HubSpot's
 *   `after` cursors AND Attio's limit/offset (the Attio client synthesizes a
 *   cursor from the next offset). `null` means the source is exhausted — the
 *   stale pass keys off that, never off page-length heuristics.
 *
 * Read-only by design: nothing behind this interface can write to a CRM.
 */

import type { Effect } from "effect";
import type { CrmError } from "../crm/errors.js";
import type { CrmFilter, FlatValue } from "../crm/crm-values.js";

export type CrmProvider = "attio" | "hubspot";

/** Display names for user-facing copy (crm/error-copy.ts interpolates these). */
export const CRM_DISPLAY_NAMES: Readonly<Record<CrmProvider, string>> = {
  attio: "Attio",
  hubspot: "HubSpot",
};

export interface CrmTokens {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresAtMs?: number;
}

/** One workspace's live CRM access: current tokens + how to persist a refresh. */
export interface CrmSession {
  readonly workspaceId: string;
  readonly tokens: CrmTokens;
  /**
   * Persist refreshed tokens. Failures are swallowed by clients (the
   * refreshed token still works in-memory for this run; the next run will
   * refresh again) — persistence must never fail a sync.
   */
  readonly persist: (tokens: CrmTokens) => Effect.Effect<void, never>;
}

export interface CrmObjectSummary {
  readonly slug: string;
  readonly label: string;
}

export interface CrmListSummary {
  readonly id: string;
  readonly name: string;
  /** The object slug this list's entries reference (e.g. "people", "contacts"). */
  readonly parentObject: string;
}

export interface CrmAttribute {
  readonly slug: string;
  readonly title: string;
  /** The PROVIDER's type name — pass it back via `attrs` when querying records. */
  readonly type: string;
  readonly supported: boolean;
}

/** An attribute the caller wants flattened onto records it queries. */
export interface CrmAttrRef {
  readonly slug: string;
  readonly type: string;
}

/** A record with its requested attributes pre-flattened to cell values. */
export interface CrmRecord {
  readonly recordId: string;
  readonly values: Readonly<Record<string, FlatValue>>;
}

export interface CrmListEntry {
  readonly entryId: string;
  readonly parentObject: string;
  readonly parentRecordId: string;
}

/** One page of a cursor-paged pull. `nextCursor === null` ⇒ source exhausted. */
export interface CrmPage<A> {
  readonly items: readonly A[];
  readonly nextCursor: string | null;
}

/** The full surface `CrmSyncService` consumes. */
export interface CrmClientApi {
  readonly provider: CrmProvider;
  /** User-facing product name ("Attio", "HubSpot"). */
  readonly displayName: string;
  /** The provider's page ceiling — drives the run's page budget + chunking. */
  readonly pageLimit: number;

  /** The connected CRM workspace/portal's identity (OAuth callback meta). */
  readonly identifySelf: (
    session: CrmSession,
  ) => Effect.Effect<{ readonly workspaceId: string; readonly workspaceName: string }, CrmError>;

  readonly listObjects: (session: CrmSession) => Effect.Effect<readonly CrmObjectSummary[], CrmError>;
  readonly listLists: (session: CrmSession) => Effect.Effect<readonly CrmListSummary[], CrmError>;

  readonly getAttributes: (
    session: CrmSession,
    target: "objects" | "lists",
    identifier: string,
    sourceLabel: string,
  ) => Effect.Effect<readonly CrmAttribute[], CrmError>;

  readonly queryObjectRecords: (
    session: CrmSession,
    args: {
      readonly object: string;
      readonly sourceLabel: string;
      readonly attrs: readonly CrmAttrRef[];
      /** Provider-opaque prefilter from {@link CrmClientApi.compileServerFilter}. */
      readonly filter?: unknown;
      readonly limit: number;
      readonly cursor: string | null;
    },
  ) => Effect.Effect<CrmPage<CrmRecord>, CrmError>;

  /**
   * The object slug a list's entries belong to, resolved from LIST METADATA —
   * never from its members (an empty list must still describe and sync).
   * "" when the provider can't tell (callers fall back / degrade).
   */
  readonly getListParent: (
    session: CrmSession,
    args: { readonly listId: string; readonly sourceLabel: string },
  ) => Effect.Effect<string, CrmError>;

  readonly queryListEntries: (
    session: CrmSession,
    args: {
      readonly listId: string;
      readonly sourceLabel: string;
      readonly limit: number;
      readonly cursor: string | null;
    },
  ) => Effect.Effect<CrmPage<CrmListEntry>, CrmError>;

  /** Fetch specific records by id (list hydration). Self-chunks to the provider's batch limits. */
  readonly queryRecordsByIds: (
    session: CrmSession,
    args: {
      readonly object: string;
      readonly sourceLabel: string;
      readonly attrs: readonly CrmAttrRef[];
      readonly ids: readonly string[];
    },
  ) => Effect.Effect<readonly CrmRecord[], CrmError>;

  /** Resolve record ids → display names (reference cells). Self-chunks. */
  readonly resolveRecordNames: (
    session: CrmSession,
    args: { readonly object: string; readonly ids: readonly string[] },
  ) => Effect.Effect<ReadonlyMap<string, string>, CrmError>;

  /** Actor/owner id → member name (Owner cells). */
  readonly listMembers: (session: CrmSession) => Effect.Effect<ReadonlyMap<string, string>, CrmError>;

  /**
   * Compile wizard filters into the provider's server-side prefilter, or
   * undefined when none is expressible. An OPTIMIZATION only — the engine
   * always re-checks every record worker-side (`matchesAllFilters`).
   */
  readonly compileServerFilter: (
    filters: readonly CrmFilter[],
    kind: "object" | "list",
  ) => unknown | undefined;
}
