# Effect-TS service + test conventions

All **business logic / services** in GTM Grid are written with [Effect-TS](https://effect.website):
services with **typed errors** and **`Layer`-based dependency injection**. React
components stay plain React — Effect is for logic/services only, never for rendering.

The canonical reference implementation lives at:

- `packages/engine/src/sample-service.ts` — the service (`CellCoercionService`)
- `packages/engine/src/sample-service.test.ts` — the test

Copy that shape for every new service (the `GridStore` service in the engine, the
Convex domain logic, the client-side cloud/sync services, etc.).

## Service rules

1. **Typed errors, not exceptions.** Define errors with `Data.TaggedError(...)`.
   They travel in the Effect error channel and are matched by `_tag` via
   `Effect.catchTag` / `Effect.catchTags`. No thrown exceptions in service code.

2. **No `as` casts.** Model the types correctly instead.

3. **Define services with `Effect.Service`** (combines the `Context.Tag` and the
   `Layer` in one declaration):
   - `sync: () => ({...})` for synchronous, dependency-free init.
   - `effect: Effect.gen(function* () { const dep = yield* Dep; return {...} })`
     when the service needs to resolve dependencies; list them in `dependencies`.
   - The generated `MyService.Default` is the real Layer you provide to run code.

4. **Methods return `Effect.Effect<Success, TypedError>`** and are composed with
   `Effect.gen`. Callers `Effect.provide(layer)` then `Effect.runPromise`.

5. **DB / external access lives behind service methods** — no raw `better-sqlite3`,
   Convex client, or `fetch` calls in routers, handlers, or UI.

   > Convex handlers stay Convex; the business logic inside them runs as Effect via
   > `Effect.runPromise`, with `ctx` provided through a `Layer`.

## Test rules

1. **Test outcomes, not implementation.** Assert the returned value or the typed
   error tag — never internal calls.

2. **Cover happy path + error paths + edge cases** named in the acceptance criteria.

3. **Use Effect test Layers instead of mocks.** Provide a real `.Default` Layer for
   integration-style tests, or a hand-written `Layer.succeed(Service, { ...stub })`
   to substitute a dependency deterministically. No mocking framework needed.

4. **Assert typed failures with `Effect.runPromiseExit` + `Cause.failureOption`**
   (or `Exit.isFailure`) so the error channel is checked without `try/catch`.

## Running the gate

The verify gate is **`pnpm typecheck && pnpm test`**:

- `pnpm typecheck` → `tsc -b` (project references; the root `tsconfig.json` is a
  solution file referencing each composite package).
- `pnpm test` → `vitest run`, driven by the root `vitest.config.ts` `projects`
  config, which discovers each package's `vitest.config.ts` and runs all suites.

Each package owns a `vitest.config.ts`. The engine is ESM with native/wasm deps
(`better-sqlite3`, `quickjs-emscripten`), so its config uses the `node`
environment and keeps those modules external (never bundled by Vite).
