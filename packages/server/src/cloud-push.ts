/**
 * Cloud push path (TRI-3295) — pushing a LOCAL table to the active CLOUD project
 * from the sidecar.
 *
 * The engine owns the orchestration ({@link CloudPushService}: read local table,
 * map/validate via CloudSchemaMapping, retry/jitter/timeout/rate-limit/bounded
 * concurrency); this module is the SIDECAR WIRING. It builds a THIN,
 * NON-RETRYING {@link CloudPushTransport} that talks to the apps/web tRPC `grid`
 * surface — the SAME `createTable` / `addColumn` / `addRowsWithCells` mutations
 * the CSV cloud import (`cloudImportWriter`, desktop App.tsx) uses — authenticated
 * with the signed-in member's Better Auth bearer token.
 *
 * CRITICAL: the transport does NOT use `fetchWithRetry` — a single plain `fetch`
 * per request. The {@link CloudPushService} orchestrator owns retry/rate-limit/
 * concurrency, so retrying here would nest and storm (the same constraint
 * cloud-run.ts documents around `fetchWithRetry`). The transport instead
 * CLASSIFIES each non-2xx into a typed engine push error (transient 429/503/5xx
 * with parsed `Retry-After`, 402 → CloudActionsLimitError, other 4xx → fatal) so
 * the orchestrator's retry predicate can decide.
 *
 * Metering/quota: the cloud `grid` mutations meter on the receiving end
 * (GridService.meterActions) and reject an over-quota push with
 * `CloudActionsLimitError` → HTTP 402. We surface that 402 unchanged — no
 * parallel client-side counter (TRI-3295).
 */

import { Cause, Effect, Exit } from "effect";
import {
  CloudPushService,
  type CloudPushError,
  type CloudPushTransport,
  type PushResult,
  FatalPushError,
  TransientPushError,
  CloudActionsLimitError,
  parseRetryAfter,
} from "@gtmgrid/engine";
import { Db } from "@gtmgrid/engine";

/** Inputs the desktop forwards to push a local table to the cloud. */
export interface CloudPushRequest {
  /** The apps/web API base URL (the desktop's `VITE_API_URL`). */
  readonly apiUrl: string;
  /** The signed-in member's Better Auth bearer token. */
  readonly token: string;
  /** The active cloud `projects.id` the table is pushed into. */
  readonly projectId: string;
  /** The LOCAL `tables.id` to push. */
  readonly localTableId: string;
  /**
   * Explicit confirmation that a re-push may OVERWRITE the linked cloud table's
   * data (destructive). Required for a re-push; ignored for a first push.
   */
  readonly confirmOverwrite?: boolean;
}

/** The dependencies a push is built from (injected for testing). */
export interface CloudPushDeps {
  /** Build the thin tRPC transport for an apps/web base URL + member token. */
  readonly makeTransport: (
    apiUrl: string,
    token: string,
    projectId: string,
  ) => CloudPushTransport;
  /** Resolve the local project Db the table lives in (the sidecar's current db). */
  readonly localDb: Db;
}

/** A non-2xx tRPC response we must classify into a typed engine push error. */
interface TrpcFailure {
  readonly status: number;
  readonly statusText: string;
  readonly body: string;
  readonly retryAfter: string | null;
}

/** Status codes that are safe to retry (transient upstream failures). */
function isTransientStatus(status: number): boolean {
  return status === 429 || status === 503 || (status >= 500 && status <= 599);
}

/**
 * Classify a tRPC failure into the typed {@link CloudPushError} the engine
 * orchestrator's retry predicate understands: 402 → quota, 429/503/5xx →
 * transient (carrying the parsed `Retry-After`), other 4xx → fatal.
 */
function classify(operation: string, f: TrpcFailure): CloudPushError {
  const message = `tRPC ${operation} failed: ${f.status} ${f.statusText} ${f.body}`.trim();
  if (f.status === 402) {
    return new CloudActionsLimitError({ message });
  }
  if (isTransientStatus(f.status)) {
    const retryAfterMs = parseRetryAfter(f.retryAfter, Date.now(), 30_000);
    return new TransientPushError({
      message,
      operation,
      status: f.status,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    });
  }
  return new FatalPushError({ message, operation, status: f.status });
}

/** A network/transport-level throw (no HTTP response) — transient by nature. */
function classifyThrow(operation: string, cause: unknown): CloudPushError {
  return new TransientPushError({
    message: cause instanceof Error ? cause.message : String(cause),
    operation,
    cause,
  });
}

/** Resolve the shared apps/web base URL with any trailing slash trimmed. */
function trpcBase(apiUrl: string): string {
  return `${apiUrl.replace(/\/+$/, "")}/api/trpc`;
}

/**
 * Build the thin tRPC {@link CloudPushTransport}. Each method is ONE plain
 * `fetch` (no retry) to a `grid.*` procedure, classifying any non-2xx into a
 * typed engine push error. Mutations POST the raw input JSON (no transformer is
 * configured server-side); queries GET with `?input=`. The Better Auth bearer
 * authenticates the member.
 */
export function makeTrpcPushTransport(
  apiUrl: string,
  token: string,
  projectId: string,
): CloudPushTransport {
  const base = trpcBase(apiUrl);
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };

  /** Read a non-2xx response into a classifiable failure. */
  const toFailure = async (
    operation: string,
    res: Response,
  ): Promise<CloudPushError> => {
    const body = await res.text().catch(() => "");
    return classify(operation, {
      status: res.status,
      statusText: res.statusText,
      body,
      retryAfter: res.headers.get("retry-after"),
    });
  };

  /** Read a tRPC envelope's `result.data` as `unknown` (no casts). */
  const readData = (operation: string, raw: unknown): unknown => {
    if (
      typeof raw === "object" &&
      raw !== null &&
      "result" in raw &&
      typeof raw.result === "object" &&
      raw.result !== null &&
      "data" in raw.result
    ) {
      return raw.result.data;
    }
    void operation;
    return undefined;
  };

  /** POST/GET a tRPC procedure and return its `result.data` as `unknown`. */
  const call = (
    operation: string,
    init: RequestInit,
    suffix = "",
  ): Effect.Effect<unknown, CloudPushError> =>
    Effect.tryPromise({
      try: () => fetch(`${base}/${operation}${suffix}`, { ...init, headers }),
      catch: (cause) => classifyThrow(operation, cause),
    }).pipe(
      Effect.flatMap((res) =>
        res.ok
          ? Effect.tryPromise({
              try: (): Promise<unknown> => res.json(),
              catch: (cause) =>
                new FatalPushError({
                  message: `tRPC ${operation} returned an unreadable body`,
                  operation,
                  cause,
                }),
            }).pipe(Effect.map((raw) => readData(operation, raw)))
          : Effect.flatMap(
              Effect.promise(() => toFailure(operation, res)),
              Effect.fail,
            ),
      ),
    );

  /** A tRPC mutation: POST raw input. */
  const mutate = (
    operation: string,
    input: unknown,
  ): Effect.Effect<unknown, CloudPushError> =>
    call(operation, { method: "POST", body: JSON.stringify(input) });

  /** A tRPC query: GET with `?input=`. */
  const queryGet = (
    operation: string,
    input: unknown,
  ): Effect.Effect<unknown, CloudPushError> =>
    call(operation, { method: "GET" }, `?input=${encodeURIComponent(JSON.stringify(input))}`);

  /** Narrow a created-id mutation result to its string id (no casts). */
  const expectId = (
    operation: string,
    data: unknown,
  ): Effect.Effect<string, FatalPushError> =>
    typeof data === "string"
      ? Effect.succeed(data)
      : Effect.fail(
          new FatalPushError({
            message: `tRPC ${operation} did not return a string id`,
            operation,
          }),
        );

  /** Narrow a `grid.getTable` payload to its row/column ids (no casts). */
  const readGridIds = (
    data: unknown,
  ): { rowIds: string[]; columnIds: string[] } => {
    const idsFrom = (value: unknown): string[] =>
      Array.isArray(value)
        ? value.flatMap((entry) =>
            typeof entry === "object" &&
            entry !== null &&
            "_id" in entry &&
            typeof entry._id === "string"
              ? [entry._id]
              : [],
          )
        : [];
    const rows =
      typeof data === "object" && data !== null && "rows" in data
        ? idsFrom(data.rows)
        : [];
    const columns =
      typeof data === "object" && data !== null && "columns" in data
        ? idsFrom(data.columns)
        : [];
    return { rowIds: rows, columnIds: columns };
  };

  return {
    createTable: (name) =>
      mutate("grid.createTable", { projectId, name }).pipe(
        Effect.flatMap((data) => expectId("grid.createTable", data)),
      ),

    addColumn: (cloudTableId, col) =>
      mutate("grid.addColumn", {
        tableId: cloudTableId,
        name: col.name,
        type: col.type,
        kind: "manual",
      }).pipe(Effect.flatMap((data) => expectId("grid.addColumn", data))),

    addRowsWithCells: (cloudTableId, rows) =>
      mutate("grid.addRowsWithCells", {
        tableId: cloudTableId,
        rows,
      }).pipe(Effect.asVoid),

    tableExists: (cloudTableId) =>
      queryGet("grid.getTable", { tableId: cloudTableId }).pipe(
        Effect.map((data) => data !== null && data !== undefined),
        // A 404/NOT_FOUND for a missing table is a FATAL (non-transient) tRPC
        // error; treat it as "does not exist" rather than failing the push.
        Effect.catchTag("FatalPushError", () => Effect.succeed(false)),
      ),

    clearTable: (cloudTableId) =>
      Effect.gen(function* () {
        const data = yield* queryGet("grid.getTable", {
          tableId: cloudTableId,
        });
        const { rowIds, columnIds } = readGridIds(data);
        // Drop existing rows (cells cascade) then columns, so the re-push
        // rebuilds the cloud schema + data fresh from local (one-way). Sequential
        // here is fine: the orchestrator rate-limits each call as one token.
        for (const rowId of rowIds) {
          yield* mutate("grid.deleteRow", { rowId });
        }
        for (const columnId of columnIds) {
          yield* mutate("grid.deleteColumn", { columnId });
        }
      }),
  };
}

/** Default deps: the tRPC transport + the supplied local Db. */
export function defaultCloudPushDeps(localDb: Db): CloudPushDeps {
  return {
    makeTransport: (apiUrl, token, projectId) =>
      makeTrpcPushTransport(apiUrl, token, projectId),
    localDb,
  };
}

/**
 * Push a local table to the active cloud project. Builds the thin tRPC transport,
 * then runs the engine's {@link CloudPushService} orchestrator (which owns all
 * resilience) against the local Db. Returns the structured {@link PushResult}
 * (created vs overwritten + row/column counts + cloud table id) so the desktop
 * can show the correct destructive-overwrite warning. Typed push errors propagate
 * so the caller maps a {@link CloudActionsLimitError} to a 402.
 */
export async function runCloudPush(
  req: CloudPushRequest,
  deps: CloudPushDeps,
): Promise<PushResult> {
  const transport = deps.makeTransport(req.apiUrl, req.token, req.projectId);
  const exit = await Effect.runPromiseExit(
    Effect.gen(function* () {
      const svc = yield* CloudPushService;
      return yield* svc.pushTable(deps.localDb, transport, {
        localTableId: req.localTableId,
        ...(req.confirmOverwrite !== undefined
          ? { confirmOverwrite: req.confirmOverwrite }
          : {}),
      });
    }).pipe(Effect.provide(CloudPushService.Default)),
  );
  if (Exit.isSuccess(exit)) return exit.value;
  // Re-throw the RAW typed push error (preserving its `_tag`) so the caller can
  // map CloudActionsLimitError → 402 / LinkConflictError → 409. A defect (no
  // typed failure) is re-thrown as-is for a generic 500.
  const failure = Cause.failureOption(exit.cause);
  if (failure._tag === "Some") throw failure.value;
  throw new Error(Cause.pretty(exit.cause));
}
