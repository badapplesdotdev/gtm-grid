/**
 * Cloud run orchestration (T9) — client-side LOGIC as an Effect service.
 *
 * Running a column on a CLOUD project does NOT happen in the browser: execution
 * stays LOCAL. The UI asks the local sidecar to run the column against the
 * apps/web tRPC API (see packages/server/src/cloud-run.ts). This service owns
 * that orchestration: it assembles the request (API url + the signed-in
 * member's auth token + table/column ids) and POSTs it to the sidecar, mapping
 * failures into a typed error.
 *
 * Per the repo convention, React components stay plain React; this client LOGIC
 * is an Effect service with typed errors + a Layer, so it can be unit-tested by
 * providing a fake {@link CloudRunner} Layer (no real sidecar). The thin React
 * hook that binds this to component state lives in ./useCloudGrid.ts.
 */

import { Context, Data, Effect, Layer } from "effect";
import { API_BASE } from "../api";

/** A request to run one column on a cloud project via the local sidecar. */
export interface CloudRunInput {
  /** The `tables.id` the column belongs to. */
  readonly tableId: string;
  /** The `columns.id` to run. */
  readonly columnId: string;
  /** Re-run cells already marked `done`. */
  readonly force?: boolean;
  /** Restrict the run to these `rows.id`s (defaults to all rows). */
  readonly rowIds?: readonly string[];
}

/** The sidecar's `{ ran, errors }` summary for a completed run. */
export interface CloudRunResult {
  readonly ran: number;
  readonly errors: number;
}

/**
 * The signed-in session a cloud run authenticates with: the apps/web `apiUrl` +
 * the Better Auth bearer token. The sidecar payload forwards both (see
 * {@link HttpCloudRunnerLive}).
 */
export interface CloudSession {
  /** The apps/web API base URL (the desktop's `VITE_API_URL`). */
  readonly apiUrl: string;
  /** The signed-in member's Better Auth bearer token. */
  readonly token: string;
}

/** Raised when the cloud run cannot be started or the sidecar rejects it. */
export class CloudRunError extends Data.TaggedError("CloudRunError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * The transport that actually performs the sidecar call. Abstracted behind a
 * service tag so the orchestration can be tested with a fake (no HTTP). The
 * default Layer ({@link HttpCloudRunnerLive}) POSTs to the sidecar.
 */
export interface CloudRunnerShape {
  readonly run: (
    session: CloudSession,
    input: CloudRunInput,
  ) => Effect.Effect<CloudRunResult, CloudRunError>;
}

export class CloudRunner extends Context.Tag("CloudRunner")<
  CloudRunner,
  CloudRunnerShape
>() {}

/** The cloud-run orchestration service the UI calls. */
export interface CloudRunServiceShape {
  /**
   * Run a column on a cloud project. Fails with {@link CloudRunError} when there
   * is no signed-in session/token, or the sidecar call fails.
   */
  readonly runColumn: (
    session: CloudSession | null,
    input: CloudRunInput,
  ) => Effect.Effect<CloudRunResult, CloudRunError>;
}

export class CloudRunService extends Context.Tag("CloudRunService")<
  CloudRunService,
  CloudRunServiceShape
>() {}

/**
 * The orchestration: validate we have a session/token, then delegate to the
 * injected {@link CloudRunner}. Requiring `CloudRunner` means the same service
 * works against the real sidecar (Live Layer) or a fake (tests).
 */
export const CloudRunServiceLive: Layer.Layer<CloudRunService, never, CloudRunner> =
  Layer.effect(
    CloudRunService,
    Effect.gen(function* () {
      const runner = yield* CloudRunner;
      return {
        runColumn: (session, input) =>
          session === null || session.token.trim() === ""
            ? Effect.fail(
                new CloudRunError({
                  message: "Sign in to a workspace to run a cloud column.",
                }),
              )
            : runner.run(session, input),
      } satisfies CloudRunServiceShape;
    }),
  );

/** The sidecar base URL (matches packages/desktop/src/api.ts `API_BASE`). */
const SIDECAR_BASE: string =
  (import.meta as unknown as { env?: { VITE_API?: string } }).env?.VITE_API ??
  "http://localhost:8787";

/**
 * A {@link CloudRunner} that POSTs to the sidecar's `/api/cloud/columns/run`.
 * This is the production transport; the request body matches the server route's
 * `CloudRunRequest` shape.
 */
export const HttpCloudRunnerLive: Layer.Layer<CloudRunner> = Layer.succeed(
  CloudRunner,
  {
    run: (session, input) =>
      Effect.tryPromise({
        try: async () => {
          const res = await fetch(`${SIDECAR_BASE}/api/cloud/columns/run`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            // Forward the apps/web API url + the Better Auth bearer token.
            body: JSON.stringify({
              apiUrl: session.apiUrl,
              token: session.token,
              tableId: input.tableId,
              columnId: input.columnId,
              force: input.force ?? false,
              rowIds: input.rowIds,
            }),
          });
          const json = (await res.json().catch(() => ({}))) as
            | CloudRunResult
            | { error?: string };
          if (!res.ok || "error" in json) {
            throw new Error(
              ("error" in json && json.error) || res.statusText || "Cloud run failed",
            );
          }
          return json as CloudRunResult;
        },
        catch: (cause) =>
          new CloudRunError({
            message: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
      }),
  },
);

/** One previewed row from the "Try on N rows" cloud dry-run. */
export interface CloudPreviewRow {
  readonly rowId: string;
  readonly value?: unknown;
  readonly error?: string;
}

/**
 * "Try on N rows" preview for a CLOUD table: POST the (unsaved) function column
 * to the sidecar's `/api/cloud/preview-function`, which dry-runs it against the
 * first `limit` rows WITHOUT persisting or metering anything, and return the
 * per-row results. Throws {@link CloudRunError} when there is no signed-in
 * session/token (preview needs auth to reach the cloud table) or the sidecar
 * rejects the call. Plain Promise (matches the `previewFunction` shape the
 * column-authoring modals expect).
 */
export async function runCloudPreview(
  session: CloudSession | null,
  input: {
    readonly tableId: string;
    readonly provider: string;
    readonly method: string;
    readonly params: Record<string, unknown>;
    readonly limit?: number;
  },
): Promise<{ results: CloudPreviewRow[] }> {
  if (session === null || session.token.trim() === "") {
    throw new CloudRunError({
      message: "Sign in to a workspace to preview a cloud column.",
    });
  }
  const res = await fetch(`${API_BASE}/api/cloud/preview-function`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      apiUrl: session.apiUrl,
      token: session.token,
      tableId: input.tableId,
      provider: input.provider,
      method: input.method,
      params: input.params,
      limit: input.limit,
    }),
  });
  const json = (await res.json().catch(() => ({}))) as
    | { results?: CloudPreviewRow[] }
    | { error?: string };
  if (!res.ok || "error" in json) {
    throw new CloudRunError({
      message:
        ("error" in json && json.error) || res.statusText || "Cloud preview failed",
    });
  }
  return { results: ("results" in json && json.results) || [] };
}

/** The full Live wiring: the orchestration over the HTTP transport. */
export const CloudRunLive: Layer.Layer<CloudRunService> = CloudRunServiceLive.pipe(
  Layer.provide(HttpCloudRunnerLive),
);

/**
 * Convenience: run a column via the orchestration, returning a Promise (so the
 * React hook can `await` it). Accepts the runner/orchestration Layer so callers
 * (and tests) choose the transport.
 */
export function runCloudColumn(
  session: CloudSession | null,
  input: CloudRunInput,
  layer: Layer.Layer<CloudRunService> = CloudRunLive,
): Promise<CloudRunResult> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const svc = yield* CloudRunService;
      return yield* svc.runColumn(session, input);
    }).pipe(Effect.provide(layer)),
  );
}
