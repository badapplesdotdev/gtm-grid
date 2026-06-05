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
import { describe, expect, it } from "vitest";
import {
  CloudRunError,
  CloudRunService,
  CloudRunServiceLive,
  CloudRunner,
  type CloudRunInput,
  type CloudRunResult,
  type CloudSession,
} from "./cloud-run";

const session: CloudSession = {
  convexUrl: "https://fake.convex.cloud",
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
          { convexUrl: "https://fake.convex.cloud", token: "   " },
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
