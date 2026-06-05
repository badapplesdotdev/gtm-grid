/**
 * CANONICAL EFFECT-TS TEST PATTERN — copy this for every new engine service test.
 *
 * Two things every later lane reuses from here:
 *
 *   1. Run an Effect program by providing the service's `.Default` Layer and
 *      calling `Effect.runPromise` (success) or `Effect.runPromiseExit`
 *      (to assert on the typed failure channel without try/catch).
 *
 *   2. For services with dependencies, provide a hand-written test Layer
 *      (`Layer.succeed(Service, { ...stub })`) INSTEAD of a mocking framework.
 *      The `stubLayer` test at the bottom demonstrates the convention even
 *      though this dependency-free sample doesn't strictly need it.
 *
 * Tests assert OUTCOMES (returned value / error tag), never implementation.
 */

import { Effect, Exit, Layer, Cause } from "effect";
import { describe, expect, it } from "vitest";
import {
  CellCoercionError,
  CellCoercionService,
  type CoercedValue,
} from "./sample-service.js";

/** Helper: run a program against the real service layer and get the value. */
const run = <A>(
  program: Effect.Effect<A, CellCoercionError, CellCoercionService>,
) => Effect.runPromise(program.pipe(Effect.provide(CellCoercionService.Default)));

/** Helper: run and capture the Exit so we can assert on typed failures. */
const runExit = <A>(
  program: Effect.Effect<A, CellCoercionError, CellCoercionService>,
) =>
  Effect.runPromiseExit(
    program.pipe(Effect.provide(CellCoercionService.Default)),
  );

describe("CellCoercionService", () => {
  describe("happy path", () => {
    it("coerces text from non-string inputs", async () => {
      const value = await run(
        Effect.gen(function* () {
          const svc = yield* CellCoercionService;
          return yield* svc.coerce("text", 123);
        }),
      );
      expect(value).toBe("123");
    });

    it("coerces numeric strings to numbers", async () => {
      const value = await run(
        Effect.gen(function* () {
          const svc = yield* CellCoercionService;
          return yield* svc.coerce("number", "42.5");
        }),
      );
      expect(value).toBe(42.5);
    });

    it("coerces boolean-ish inputs", async () => {
      const truthy = await run(
        Effect.gen(function* () {
          const svc = yield* CellCoercionService;
          return yield* svc.coerce("boolean", "true");
        }),
      );
      const falsy = await run(
        Effect.gen(function* () {
          const svc = yield* CellCoercionService;
          return yield* svc.coerce("boolean", 0);
        }),
      );
      expect(truthy).toBe(true);
      expect(falsy).toBe(false);
    });

    it("coerces parseable dates to epoch millis", async () => {
      const value = await run(
        Effect.gen(function* () {
          const svc = yield* CellCoercionService;
          return yield* svc.coerce("date", "2026-06-05T00:00:00.000Z");
        }),
      );
      expect(value).toBe(Date.parse("2026-06-05T00:00:00.000Z"));
    });

    it("normalizes json strings", async () => {
      const value = await run(
        Effect.gen(function* () {
          const svc = yield* CellCoercionService;
          return yield* svc.coerce("json", '{ "b": 2,  "a": 1 }');
        }),
      );
      expect(value).toBe('{"b":2,"a":1}');
    });

    it("stringifies structured json inputs", async () => {
      const value = await run(
        Effect.gen(function* () {
          const svc = yield* CellCoercionService;
          return yield* svc.coerce("json", { a: 1 });
        }),
      );
      expect(value).toBe('{"a":1}');
    });
  });

  describe("edge cases", () => {
    it.each([null, undefined, ""])(
      "treats %s as an empty (null) cell for any column type",
      async (raw) => {
        const value = await run(
          Effect.gen(function* () {
            const svc = yield* CellCoercionService;
            return yield* svc.coerce("number", raw);
          }),
        );
        expect(value).toBeNull();
      },
    );

    it("passes through an existing boolean unchanged", async () => {
      const value = await run(
        Effect.gen(function* () {
          const svc = yield* CellCoercionService;
          return yield* svc.coerce("boolean", false);
        }),
      );
      expect(value).toBe(false);
    });
  });

  describe("error path", () => {
    it("fails with a typed CellCoercionError for a non-numeric string", async () => {
      const exit = await runExit(
        Effect.gen(function* () {
          const svc = yield* CellCoercionService;
          return yield* svc.coerce("number", "not-a-number");
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const error = Cause.failureOption(exit.cause);
        expect(error._tag).toBe("Some");
        if (error._tag === "Some") {
          expect(error.value).toBeInstanceOf(CellCoercionError);
          expect(error.value.columnType).toBe("number");
          expect(error.value.received).toBe("not-a-number");
        }
      }
    });

    it("is recoverable via Effect.catchTag", async () => {
      const value = await run(
        Effect.gen(function* () {
          const svc = yield* CellCoercionService;
          return yield* svc.coerce("boolean", "maybe");
        }).pipe(
          Effect.catchTag("CellCoercionError", () =>
            Effect.succeed<CoercedValue>(null),
          ),
        ),
      );
      expect(value).toBeNull();
    });

    it("fails on invalid json", async () => {
      const exit = await runExit(
        Effect.gen(function* () {
          const svc = yield* CellCoercionService;
          return yield* svc.coerce("json", "{not json}");
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
    });
  });

  describe("test-Layer convention", () => {
    it("can be replaced by a hand-written stub Layer (no mocking framework)", async () => {
      // This is the pattern dependency-bearing services use: swap the real
      // Layer for a deterministic stub via Layer.succeed. Effect.Service classes
      // are constructed with `new` so the stub carries the service identity (_tag).
      const StubLayer = Layer.succeed(
        CellCoercionService,
        new CellCoercionService({
          coerce: () => Effect.succeed<CoercedValue>("stubbed"),
        }),
      );

      const value = await Effect.runPromise(
        Effect.gen(function* () {
          const svc = yield* CellCoercionService;
          return yield* svc.coerce("number", 999);
        }).pipe(Effect.provide(StubLayer)),
      );

      expect(value).toBe("stubbed");
    });
  });
});
