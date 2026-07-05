/**
 * The `crm` tRPC router — member-gated Attio CRM-sync CRUD (the desktop
 * "From your CRM" cloud flow). Mirrors {@link signalsRouter}: each procedure
 * runs a `CrmSyncService` / `CrmConnectionService` Effect via {@link runCrm};
 * the service resolves the owning workspace and asserts membership + cloud
 * entitlement inside the Effect. Manual "Sync now" and post-create warm-up only
 * ENQUEUE — all sync execution runs in the Inngest worker
 * (apps/web/lib/inngest/functions/poll-crm-sync), so the enqueue is best-effort
 * (a failed send never fails the mutation; the cron is the fallback).
 *
 * Error mapping: {@link runCrm} translates CRM domain failures through
 * `crmErrorCopy` so users see human copy (e.g. `CrmConnectionMissing` →
 * "Attio isn't connected for this workspace."), and delegates the authz tags
 * (`NotAMemberError`, `PlanRequiredError`, …) to the shared `toTrpcError`.
 */

import { MembershipService } from "@gtmgrid/cloud";
import {
  type AppServices,
  AttioAuth,
  CrmConnectionService,
  CrmSyncService,
  CrmSyncError,
  crmErrorCopy,
  type CrmError,
  FILTER_OPS,
  SUPPORTED_ATTR_TYPES,
} from "@gtmgrid/services";
import { TRPCError } from "@trpc/server";
import { Cause, Effect, Exit, Option } from "effect";
import { z } from "zod";
import type { ServicesRuntime } from "../context";
import { inngest } from "../../inngest/client";
import { captureServer } from "../../posthog-server";
import { protectedProcedure, router, toTrpcError } from "../trpc";

type TrpcCode = ConstructorParameters<typeof TRPCError>[0]["code"];

/**
 * CRM failure tag → tRPC code. The message is `crmErrorCopy(e).copy` (user-safe
 * by construction); a tag absent here is not a CRM domain error and falls
 * through to the shared authz mapping. `CrmSyncError` is the catch-all (bad
 * provider, missing table/binding, repo failure) → 500 with generic copy.
 */
const CRM_ERROR_CODE: Record<string, TrpcCode> = {
  CrmConnectionMissing: "PRECONDITION_FAILED",
  AttioAuthRevoked: "PRECONDITION_FAILED",
  AttioSourceGoneError: "NOT_FOUND",
  AttioRequestError: "BAD_REQUEST",
  AttioSchemaDriftError: "BAD_REQUEST",
  RowCapReached: "BAD_REQUEST",
  AttioRateLimitError: "TOO_MANY_REQUESTS",
  AttioServerError: "BAD_GATEWAY",
  AttioNetworkError: "BAD_GATEWAY",
  CrmSyncError: "INTERNAL_SERVER_ERROR",
};

/**
 * Run a CRM Effect against the request runtime. A typed CRM failure becomes a
 * `TRPCError` whose message is the user-safe `crmErrorCopy` string; the authz
 * tags reuse {@link toTrpcError}; a defect (real crash) rethrows with the
 * squashed cause preserved for Error Tracking (as {@link runEffect} does).
 */
async function runCrm<A, E>(
  runtime: ServicesRuntime,
  program: Effect.Effect<A, E, AppServices>,
): Promise<A> {
  const exit = await runtime.runPromiseExit(program);
  if (Exit.isSuccess(exit)) return exit.value;

  const failure = Cause.failureOption(exit.cause);
  if (failure._tag === "Some") {
    const err = failure.value as { _tag?: string; message?: string };
    const code = err._tag ? CRM_ERROR_CODE[err._tag] : undefined;
    if (code !== undefined) {
      throw new TRPCError({ code, message: crmErrorCopy(err as CrmError).copy });
    }
    throw toTrpcError(err._tag, err.message ?? "Request failed.");
  }
  // Defects carry internals (DB/decrypt detail) — never surface them; the
  // squashed cause still reaches Error Tracking via `cause`.
  throw new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: "Something went wrong. Please try again in a moment.",
    cause: Cause.squash(exit.cause),
  });
}

/** The web authorize route falls back to the marketing origin off Vercel. */
const siteOrigin = (): string => process.env.SITE_URL ?? "https://www.gtmgrid.dev";

const sourceKind = z.enum(["object", "list"]);

/** One `CrmFilter` — attr type / op enums mirror the service's domain unions. */
const filter = z.object({
  attrSlug: z.string().min(1).max(200),
  attrType: z.enum(SUPPORTED_ATTR_TYPES),
  op: z.enum(FILTER_OPS),
  value: z.string().max(500),
});

/** A mapped field (attribute → synced column) for `createBinding`. */
const field = z.object({
  attrSlug: z.string().min(1).max(200),
  attrType: z.enum(SUPPORTED_ATTR_TYPES),
  title: z.string().min(1).max(200),
});

export const crmRouter = router({
  /**
   * Whether Attio OAuth is configured for the deployment (env) AND whether this
   * workspace has an active connection (member-gated read of the stored token).
   * Merged so the desktop can render "Connect Attio" vs "Connected by …" in one
   * call.
   */
  connectionStatus: protectedProcedure
    .input(z.object({ workspaceId: z.string().min(1) }))
    .query(({ ctx, input }) =>
      runCrm(
        ctx.runtime,
        Effect.gen(function* () {
          const auth = yield* AttioAuth;
          const conn = yield* CrmConnectionService;
          const configured = yield* auth.isConfigured();
          const meta = yield* conn.connectionMeta(input.workspaceId);
          return Option.match(meta, {
            onNone: () => ({ configured, connected: false as const }),
            onSome: (m) => ({
              configured,
              connected: true as const,
              connectedByName: m.connectedByName,
              attioWorkspaceName: m.attioWorkspaceName,
            }),
          });
        }),
      ),
    ),

  /**
   * The URL the desktop opens externally to start Attio OAuth. The web route
   * mints the signed state in the browser session; this only builds the entry
   * link (the authorize route itself gates access).
   */
  /**
   * The FULL Attio authorize URL with a state minted for the calling member.
   * Minted here (not in the browser) because desktop auth is bearer-based: an
   * `openExternal` browser navigation carries no gtmgrid.dev session, so the
   * web authorize route's session gate would dead-end the flow. The signed
   * state IS the trust for the callback; the browser needs no session at all.
   */
  authorizeUrl: protectedProcedure
    .input(z.object({ workspaceId: z.string().min(1) }))
    .query(({ ctx, input }) =>
      runCrm(
        ctx.runtime,
        Effect.gen(function* () {
          const membership = yield* MembershipService;
          const member = yield* membership.requireMember(input.workspaceId);
          const auth = yield* AttioAuth;
          const state = yield* auth.mintState({ workspaceId: input.workspaceId, userId: member.userId });
          if (state === null) {
            return yield* Effect.fail(
              new CrmSyncError({ message: "OAuth state signing unavailable (no BETTER_AUTH_SECRET)" }),
            );
          }
          const url = yield* auth
            .authorizeUrl(state)
            .pipe(
              Effect.catchTag("AttioOAuthNotConfigured", (e) =>
                Effect.fail(new CrmSyncError({ message: `Attio OAuth env missing: ${e.missing}` })),
              ),
            );
          return { url };
        }),
      ),
    ),

  /** Attio objects + lists available to sync (member-gated). */
  listSources: protectedProcedure
    .input(z.object({ workspaceId: z.string().min(1) }))
    .query(({ ctx, input }) =>
      runCrm(
        ctx.runtime,
        Effect.gen(function* () {
          const svc = yield* CrmSyncService;
          return yield* svc.listSources(input.workspaceId);
        }),
      ),
    ),

  /** A source's attribute schema + a suggested match key (member-gated). */
  describeSource: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string().min(1),
        kind: sourceKind,
        id: z.string().min(1),
        label: z.string(),
      }),
    )
    .query(({ ctx, input }) =>
      runCrm(
        ctx.runtime,
        Effect.gen(function* () {
          const svc = yield* CrmSyncService;
          return yield* svc.describeSource(input.workspaceId, {
            kind: input.kind,
            id: input.id,
            label: input.label,
          });
        }),
      ),
    ),

  /** Approx. row count for a source + filters — the wizard's "~N records" (member-gated). */
  estimate: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string().min(1),
        kind: sourceKind,
        id: z.string().min(1),
        label: z.string(),
        filters: z.array(filter).max(20),
      }),
    )
    .query(({ ctx, input }) =>
      runCrm(
        ctx.runtime,
        Effect.gen(function* () {
          const svc = yield* CrmSyncService;
          return yield* svc.estimate(input.workspaceId, {
            kind: input.kind,
            id: input.id,
            label: input.label,
            filters: input.filters,
          });
        }),
      ),
    ),

  /**
   * Create a binding: builds the synced columns + binding row. Members-only +
   * requires cloud entitlement + an existing Attio connection (all enforced in
   * `CrmSyncService.create`). `workspaceId` is passed for the warm-up event +
   * analytics; the service re-derives it from the table for authz.
   */
  createBinding: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string().min(1),
        tableId: z.string().min(1),
        sourceKind,
        sourceId: z.string().min(1),
        sourceLabel: z.string().min(1).max(200),
        // Bounded: one DB column insert per field — an unbounded array would be
        // a write-burst lever for any authenticated member.
        fields: z.array(field).min(1).max(100),
        filters: z.array(filter).max(20),
        dedupeMode: z.enum(["update", "skip", "create"]),
        matchKeyAttr: z.string().nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const bindingId = await runCrm(
        ctx.runtime,
        Effect.gen(function* () {
          const svc = yield* CrmSyncService;
          return yield* svc.create({
            tableId: input.tableId,
            provider: "attio",
            sourceKind: input.sourceKind,
            sourceId: input.sourceId,
            sourceLabel: input.sourceLabel,
            fields: input.fields,
            filters: input.filters,
            dedupeMode: input.dedupeMode,
            matchKeyAttr: input.matchKeyAttr,
          });
        }),
      );

      captureServer("crm_binding_created", {
        distinctId: ctx.userId,
        properties: {
          provider: "attio",
          binding_id: bindingId,
          source_kind: input.sourceKind,
          dedupe_mode: input.dedupeMode,
          columns: input.fields.length,
          filters: input.filters.length,
          workspace_id: input.workspaceId,
        },
        groups: { workspace: input.workspaceId },
      });

      // Kick off the durable first pull. BEST-EFFORT: an enqueue failure must
      // not fail the create (the binding exists) — the cron's always-due-while-
      // empty predicate fills the table on the next tick as the fallback.
      try {
        await inngest.send({
          name: "crm/binding.created",
          data: { bindingId, workspaceId: input.workspaceId },
        });
      } catch (err) {
        console.error(
          `[crm] first-pull enqueue failed for binding ${bindingId}:`,
          err instanceof Error ? err.message : err,
        );
      }
      return { bindingId };
    }),

  /**
   * Manual "Sync now": validate (member + entitlement) then enqueue the worker.
   * All execution is durable, so this only enqueues; the enqueue is best-effort
   * (the cron reconciles a dropped event within the hour).
   */
  syncNow: protectedProcedure
    .input(z.object({ bindingId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const binding = await runCrm(
        ctx.runtime,
        Effect.gen(function* () {
          const svc = yield* CrmSyncService;
          return yield* svc.guardSyncNow(input.bindingId);
        }),
      );
      try {
        await inngest.send({
          name: "crm/binding.sync-now",
          data: { bindingId: binding.id, workspaceId: binding.workspaceId },
        });
      } catch (err) {
        console.error(
          `[crm] sync-now enqueue failed for binding ${binding.id}:`,
          err instanceof Error ? err.message : err,
        );
      }
      return { enqueued: true as const };
    }),

  /** A binding's recent sync runs (newest first) — the sync log. Members-only. */
  history: protectedProcedure
    .input(
      z.object({
        bindingId: z.string().min(1),
        limit: z.number().int().min(1).max(100).default(20),
      }),
    )
    .query(({ ctx, input }) =>
      runCrm(
        ctx.runtime,
        Effect.gen(function* () {
          const svc = yield* CrmSyncService;
          return yield* svc.listRuns(input.bindingId, input.limit);
        }),
      ),
    ),

  /**
   * CRM bindings on a table. Members-only — membership is checked against the
   * TABLE's own workspace inside the service (a client-supplied workspaceId
   * was an IDOR: any member of any workspace could read another workspace's
   * binding config by table id). The desktop still sends workspaceId; zod
   * strips unknown keys, so it is simply ignored here.
   */
  listBindings: protectedProcedure
    .input(z.object({ tableId: z.string().min(1) }))
    .query(({ ctx, input }) =>
      runCrm(
        ctx.runtime,
        Effect.gen(function* () {
          const svc = yield* CrmSyncService;
          return yield* svc.listByTable(input.tableId);
        }),
      ),
    ),

  /**
   * Disconnect Attio for the workspace: pauses every synced table (Reconnect
   * banner) and deletes the stored OAuth connection. Members-only.
   */
  disconnect: protectedProcedure
    .input(z.object({ workspaceId: z.string().min(1) }))
    .mutation(({ ctx, input }) =>
      runCrm(
        ctx.runtime,
        Effect.gen(function* () {
          const svc = yield* CrmSyncService;
          return yield* svc.disconnect(input.workspaceId);
        }),
      ),
    ),

  /** Delete a binding (grid rows stay). Members-only. */
  deleteBinding: protectedProcedure
    .input(z.object({ bindingId: z.string().min(1) }))
    .mutation(({ ctx, input }) =>
      runCrm(
        ctx.runtime,
        Effect.gen(function* () {
          const svc = yield* CrmSyncService;
          return yield* svc.remove(input.bindingId);
        }),
      ),
    ),
});
