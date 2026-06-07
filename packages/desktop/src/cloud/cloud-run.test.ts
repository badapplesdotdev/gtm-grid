/**
 * Cloud run orchestration tests (T9).
 *
 * The orchestration is client-side LOGIC (an Effect service), so we test it by
 * providing a FAKE {@link CloudRunner} Layer — no real sidecar, no real Convex.
 * We assert it: (1) refuses to run without a signed-in session/token (typed
 * error), (2) forwards the request unchanged to the runner and returns its
 * result, and (3) surfaces a runner failure as a typed CloudRunError.
 */

import { Cause, Effect, Exit, Layer } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CloudRunError,
  CloudRunService,
  CloudRunServiceLive,
  CloudRunner,
  HttpCloudRunnerLive,
  type CloudRunInput,
  type CloudRunResult,
  type CloudSession,
} from "./cloud-run";

const session: CloudSession = {
  apiUrl: "https://app.gtmgrid.dev",
  token: "jwt-token",
};

/** A fake runner that records the call and returns a fixed result. */
function fakeRunner(result: CloudRunResult) {
  const calls: Array<{ session: CloudSession; input: CloudRunInput }> = [];
  const layer = CloudRunServiceLive.pipe(
    Layer.provide(
      Layer.succeed(CloudRunner, {
        run: (s, input) => {
          calls.push({ session: s, input });
          return Effect.succeed(result);
        },
      }),
    ),
  );
  return { layer, calls };
}

/** A fake runner that always fails. */
const failingLayer = CloudRunServiceLive.pipe(
  Layer.provide(
    Layer.succeed(CloudRunner, {
      run: () =>
        Effect.fail(new CloudRunError({ message: "sidecar unreachable" })),
    }),
  ),
);

const run = <A>(
  program: Effect.Effect<A, CloudRunError, CloudRunService>,
  layer: Layer.Layer<CloudRunService>,
) => Effect.runPromiseExit(program.pipe(Effect.provide(layer)));

describe("CloudRunService", () => {
  it("forwards the request to the runner and returns its result", async () => {
    const { layer, calls } = fakeRunner({ ran: 3, errors: 0 });
    const input: CloudRunInput = {
      tableId: "t1",
      columnId: "c1",
      force: true,
      rowIds: ["r1", "r2"],
    };

    const exit = await run(
      Effect.gen(function* () {
        const svc = yield* CloudRunService;
        return yield* svc.runColumn(session, input);
      }),
      layer,
    );

    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) expect(exit.value).toEqual({ ran: 3, errors: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0].session).toEqual(session);
    expect(calls[0].input).toEqual(input);
  });

  it("fails with a typed CloudRunError when there is no session", async () => {
    const { layer, calls } = fakeRunner({ ran: 0, errors: 0 });

    const exit = await run(
      Effect.gen(function* () {
        const svc = yield* CloudRunService;
        return yield* svc.runColumn(null, { tableId: "t1", columnId: "c1" });
      }),
      layer,
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = Cause.failureOption(exit.cause);
      expect(err._tag).toBe("Some");
      if (err._tag === "Some") {
        expect(err.value).toBeInstanceOf(CloudRunError);
        expect(err.value.message).toMatch(/sign in/i);
      }
    }
    // The runner was never called — orchestration short-circuited.
    expect(calls).toHaveLength(0);
  });

  it("fails with a typed CloudRunError when the token is blank", async () => {
    const { layer, calls } = fakeRunner({ ran: 0, errors: 0 });

    const exit = await run(
      Effect.gen(function* () {
        const svc = yield* CloudRunService;
        return yield* svc.runColumn(
          { apiUrl: "https://app.gtmgrid.dev", token: "   " },
          { tableId: "t1", columnId: "c1" },
        );
      }),
      layer,
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("surfaces a runner failure as a typed CloudRunError", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const svc = yield* CloudRunService;
        return yield* svc.runColumn(session, { tableId: "t1", columnId: "c1" });
      }),
      failingLayer,
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = Cause.failureOption(exit.cause);
      expect(err._tag === "Some" && err.value instanceof CloudRunError).toBe(true);
      if (err._tag === "Some") {
        expect(err.value.message).toBe("sidecar unreachable");
      }
    }
  });
});

/**
 * HttpCloudRunnerLive — the production transport (#25). We mock ONLY `fetch`
 * (the I/O boundary), running the real runner Effect, to assert: the POST body
 * shape, that a non-2xx / `{ error }` body maps to a typed CloudRunError, and
 * that a thrown (network) failure maps to a CloudRunError too.
 */
describe("HttpCloudRunnerLive", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Run the real HTTP runner's `run` with the live Layer. */
  const runHttp = (s: CloudSession, input: CloudRunInput) =>
    Effect.runPromiseExit(
      Effect.gen(function* () {
        const runner = yield* CloudRunner;
        return yield* runner.run(s, input);
      }).pipe(Effect.provide(HttpCloudRunnerLive)),
    );

  it("POSTs the request body to the sidecar and returns the parsed result", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => ({
      ok: true,
      statusText: "OK",
      json: async (): Promise<CloudRunResult> => ({ ran: 2, errors: 1 }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const input: CloudRunInput = {
      tableId: "t1",
      columnId: "c1",
      force: true,
      rowIds: ["r1", "r2"],
    };
    const exit = await runHttp(session, input);

    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) expect(exit.value).toEqual({ ran: 2, errors: 1 });

    // One POST to the run route carrying the session + input as JSON.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/api\/cloud\/columns\/run$/);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      apiUrl: session.apiUrl,
      token: session.token,
      tableId: "t1",
      columnId: "c1",
      force: true,
      rowIds: ["r1", "r2"],
    });
  });

  it("forwards the apiUrl + Better Auth token in the POST body", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => ({
      ok: true,
      statusText: "OK",
      json: async (): Promise<CloudRunResult> => ({ ran: 1, errors: 0 }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const apiSession: CloudSession = {
      apiUrl: "https://app.gtmgrid.dev",
      token: "ba_token",
    };
    const exit = await runHttp(apiSession, { tableId: "t1", columnId: "c1" });

    expect(Exit.isSuccess(exit)).toBe(true);
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({
      apiUrl: "https://app.gtmgrid.dev",
      token: "ba_token",
      tableId: "t1",
      columnId: "c1",
      force: false,
    });
  });

  it("maps a non-2xx response with an { error } body to a typed CloudRunError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        statusText: "Bad Request",
        json: async () => ({ error: "tableId is required" }),
      })),
    );

    const exit = await runHttp(session, { tableId: "", columnId: "c1" });

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = Cause.failureOption(exit.cause);
      expect(err._tag).toBe("Some");
      if (err._tag === "Some") {
        expect(err.value).toBeInstanceOf(CloudRunError);
        expect(err.value.message).toBe("tableId is required");
      }
    }
  });

  it("maps a 2xx body that carries an { error } field to a typed CloudRunError", async () => {
    // The sidecar returns 200 with { error } on a handled failure; the runner
    // must still treat that as a failure, not a (malformed) success.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        statusText: "OK",
        json: async () => ({ error: "column not found" }),
      })),
    );

    const exit = await runHttp(session, { tableId: "t1", columnId: "nope" });

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = Cause.failureOption(exit.cause);
      expect(err._tag === "Some" && err.value instanceof CloudRunError).toBe(true);
      if (err._tag === "Some") expect(err.value.message).toBe("column not found");
    }
  });

  it("maps a network failure (fetch rejects) to a typed CloudRunError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("Failed to fetch");
      }),
    );

    const exit = await runHttp(session, { tableId: "t1", columnId: "c1" });

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = Cause.failureOption(exit.cause);
      expect(err._tag).toBe("Some");
      if (err._tag === "Some") {
        expect(err.value).toBeInstanceOf(CloudRunError);
        expect(err.value.message).toBe("Failed to fetch");
        // The original cause is preserved on the typed error.
        expect(err.value.cause).toBeInstanceOf(Error);
      }
    }
  });
});
