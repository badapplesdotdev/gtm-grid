/**
 * Tests for CloudSchemaMapping — the engine<->cloud schema mapping service.
 *
 * Follows the canonical Effect test pattern (sample-service.test.ts): provide
 * the `.Default` Layer, run with Effect.runPromise(Exit), assert OUTCOMES and
 * typed error tags — never implementation details.
 *
 * These tests also pin the contract the cloud schema (convex/schema.ts) depends
 * on: cellStatus matches CellStatus, and credentialScope maps as documented.
 */

import { Cause, Effect, Exit, Layer } from "effect";
import { describe, expect, it } from "vitest";
import type { CellStatus, CredentialScope } from "./types.js";
import {
  CloudSchemaMapping,
  UnknownCellStatusError,
  UnmappableCredentialScopeError,
} from "./cloud-schema.js";

const run = <A, E>(program: Effect.Effect<A, E, CloudSchemaMapping>) =>
  Effect.runPromise(program.pipe(Effect.provide(CloudSchemaMapping.Default)));

const runExit = <A, E>(program: Effect.Effect<A, E, CloudSchemaMapping>) =>
  Effect.runPromiseExit(program.pipe(Effect.provide(CloudSchemaMapping.Default)));

/** Every CellStatus literal from packages/engine/src/types.ts. */
const ALL_CELL_STATUSES: readonly CellStatus[] = [
  "empty",
  "pending",
  "running",
  "done",
  "error",
];

describe("CloudSchemaMapping", () => {
  describe("cellStatusForCloud", () => {
    it.each(ALL_CELL_STATUSES)(
      "passes through every engine CellStatus (%s) — proves cloud cellStatus mirrors CellStatus",
      async (status) => {
        const value = await run(
          Effect.gen(function* () {
            const svc = yield* CloudSchemaMapping;
            return yield* svc.cellStatusForCloud(status);
          }),
        );
        expect(value).toBe(status);
      },
    );

    it("fails with a typed UnknownCellStatusError for an unknown status (status drift)", async () => {
      const exit = await runExit(
        Effect.gen(function* () {
          const svc = yield* CloudSchemaMapping;
          return yield* svc.cellStatusForCloud("archived");
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const error = Cause.failureOption(exit.cause);
        expect(error._tag).toBe("Some");
        if (error._tag === "Some") {
          expect(error.value).toBeInstanceOf(UnknownCellStatusError);
          expect(error.value.received).toBe("archived");
        }
      }
    });

    it("is recoverable via Effect.catchTag", async () => {
      const value = await run(
        Effect.gen(function* () {
          const svc = yield* CloudSchemaMapping;
          return yield* svc.cellStatusForCloud("nope");
        }).pipe(
          Effect.catchTag("UnknownCellStatusError", () =>
            Effect.succeed("empty" as const),
          ),
        ),
      );
      expect(value).toBe("empty");
    });
  });

  describe("credentialScopeForCloud", () => {
    it("maps engine 'team' to cloud 'workspace' (shared team key)", async () => {
      const value = await run(
        Effect.gen(function* () {
          const svc = yield* CloudSchemaMapping;
          return yield* svc.credentialScopeForCloud("team");
        }),
      );
      expect(value).toBe("workspace");
    });

    it("maps engine 'personal' to cloud 'personal'", async () => {
      const value = await run(
        Effect.gen(function* () {
          const svc = yield* CloudSchemaMapping;
          return yield* svc.credentialScopeForCloud("personal");
        }),
      );
      expect(value).toBe("personal");
    });

    it("fails with UnmappableCredentialScopeError for engine 'local' (never synced)", async () => {
      const exit = await runExit(
        Effect.gen(function* () {
          const svc = yield* CloudSchemaMapping;
          return yield* svc.credentialScopeForCloud("local");
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const error = Cause.failureOption(exit.cause);
        expect(error._tag).toBe("Some");
        if (error._tag === "Some") {
          expect(error.value).toBeInstanceOf(UnmappableCredentialScopeError);
          expect(error.value.received).toBe("local");
        }
      }
    });

    it.each<[CredentialScope, "workspace" | "personal"]>([
      ["team", "workspace"],
      ["personal", "personal"],
    ])("only produces cloud-valid scopes (%s -> %s)", async (input, expected) => {
      const value = await run(
        Effect.gen(function* () {
          const svc = yield* CloudSchemaMapping;
          return yield* svc.credentialScopeForCloud(input);
        }),
      );
      expect(["workspace", "personal"]).toContain(value);
      expect(value).toBe(expected);
    });
  });

  describe("test-Layer convention (no mocking framework)", () => {
    it("can be substituted by a hand-written stub Layer", async () => {
      const StubLayer = Layer.succeed(
        CloudSchemaMapping,
        new CloudSchemaMapping({
          cellStatusForCloud: () => Effect.succeed("done" as const),
          credentialScopeForCloud: () => Effect.succeed("personal" as const),
        }),
      );

      const value = await Effect.runPromise(
        Effect.gen(function* () {
          const svc = yield* CloudSchemaMapping;
          return yield* svc.cellStatusForCloud("empty");
        }).pipe(Effect.provide(StubLayer)),
      );
      expect(value).toBe("done");
    });
  });
});
