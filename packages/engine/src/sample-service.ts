/**
 * CANONICAL EFFECT-TS SERVICE PATTERN — copy this for every new engine service.
 *
 * Every business-logic service in the engine (and later the cloud lanes) follows
 * this exact shape so the codebase stays consistent and testable:
 *
 *   1. Typed errors via `Data.TaggedError` — no thrown exceptions, no `as` casts.
 *      Errors live in the Effect error channel and are matched by their `_tag`.
 *
 *   2. A service defined with the `Effect.Service` pattern (Tag + Layer in one).
 *      The generated `<Service>.Default` Layer wires the real implementation; a
 *      hand-written `Layer.succeed(<Service>, {...})` provides a deterministic
 *      test double — that is why tests need NO mocking framework.
 *
 *   3. Methods return `Effect.Effect<Success, TypedError>` and are composed with
 *      `Effect.gen`. Callers `Effect.provide(...)` a Layer and `Effect.runPromise`.
 *
 * This `CellCoercionService` is intentionally tiny and dependency-free; its only
 * job is to be the reference implementation. The real `GridStore` service (T2)
 * lives next to this file and mirrors this structure.
 *
 * See docs/effect-conventions.md for the prose write-up.
 */

import { Data, Effect } from "effect";
import type { ColumnType } from "./types.js";

/**
 * Raised when a raw value cannot be coerced to the requested {@link ColumnType}.
 * Lives in the Effect error channel so callers handle it with `Effect.catchTag`.
 */
export class CellCoercionError extends Data.TaggedError("CellCoercionError")<{
  readonly message: string;
  readonly columnType: ColumnType;
  readonly received: unknown;
}> {}

/** The value a coerced cell can hold for each supported {@link ColumnType}. */
export type CoercedValue = string | number | boolean | null;

/**
 * Coerces a raw column-cell input into the canonical value for its column type,
 * failing with a typed {@link CellCoercionError} when the input is invalid.
 * This is the unit later stores call before persisting a cell value.
 */
export class CellCoercionService extends Effect.Service<CellCoercionService>()(
  "CellCoercionService",
  {
    // `sync` — no async work and no dependencies, so initialization is synchronous.
    // Use `effect` instead when a service needs to `yield*` its dependencies.
    sync: () => ({
      coerce: (
        columnType: ColumnType,
        raw: unknown,
      ): Effect.Effect<CoercedValue, CellCoercionError> =>
        Effect.gen(function* () {
          // Empty cells are represented as null for every column type.
          if (raw === null || raw === undefined || raw === "") {
            return null;
          }

          switch (columnType) {
            case "text":
              return typeof raw === "string" ? raw : String(raw);

            case "number": {
              const n = typeof raw === "number" ? raw : Number(raw);
              if (Number.isNaN(n)) {
                return yield* Effect.fail(
                  new CellCoercionError({
                    message: `Cannot coerce ${JSON.stringify(raw)} to a number`,
                    columnType,
                    received: raw,
                  }),
                );
              }
              return n;
            }

            case "boolean": {
              if (typeof raw === "boolean") return raw;
              if (raw === "true" || raw === 1) return true;
              if (raw === "false" || raw === 0) return false;
              return yield* Effect.fail(
                new CellCoercionError({
                  message: `Cannot coerce ${JSON.stringify(raw)} to a boolean`,
                  columnType,
                  received: raw,
                }),
              );
            }

            case "date": {
              // Accept epoch millis or an ISO/parseable date string; store as epoch millis.
              const ms =
                typeof raw === "number" ? raw : Date.parse(String(raw));
              if (Number.isNaN(ms)) {
                return yield* Effect.fail(
                  new CellCoercionError({
                    message: `Cannot coerce ${JSON.stringify(raw)} to a date`,
                    columnType,
                    received: raw,
                  }),
                );
              }
              return ms;
            }

            case "json": {
              if (typeof raw !== "string") {
                // Already a structured value — round-trip to its JSON string form.
                return JSON.stringify(raw);
              }
              try {
                return JSON.stringify(JSON.parse(raw));
              } catch {
                return yield* Effect.fail(
                  new CellCoercionError({
                    message: `Cannot coerce ${JSON.stringify(raw)} to JSON`,
                    columnType,
                    received: raw,
                  }),
                );
              }
            }
          }
        }),
    }),
  },
) {}
