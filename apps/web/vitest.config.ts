import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The web app's OFFLINE suites: tRPC procedure tests (createCaller against a
// TestLayer context) plus the API-route boundary tests (the worker secret/zod
// gate, the worker body schemas). They never open a live connection — services
// are swapped for in-memory Test Layers and the validation/gate paths return
// before any DB import — so the default "node" environment runs them directly.

const src = (pkg: string, entry = "src/index.ts") =>
  fileURLToPath(new URL(`../../packages/${pkg}/${entry}`, import.meta.url));

export default defineConfig({
  test: {
    name: "web",
    environment: "node",
    include: ["lib/**/*.test.ts", "app/**/*.test.ts"],
  },
  resolve: {
    /**
     * Resolve workspace packages straight to their SOURCE.
     *
     * Not a workaround for a build step — these packages have no build; their
     * package.json `exports` already point at `./src/*.ts`, so this alias is
     * semantically identical to what a correct pnpm link provides.
     *
     * It exists because a git worktree shares the MAIN checkout's `node_modules`,
     * where the `@gtmgrid/*` links may be absent or point at a DIFFERENT
     * worktree. Without it EVERY suite here fails to collect with "Cannot find
     * package '@gtmgrid/services'", which reads as broken imports rather than an
     * environment quirk.
     *
     * Order matters: Vite matches string aliases by PREFIX, so every subpath must
     * be listed ABOVE its bare package or the bare entry swallows it.
     */
    alias: {
      "@gtmgrid/db/client": src("db", "src/client.ts"),
      "@gtmgrid/db/schema": src("db", "src/schema.ts"),
      "@gtmgrid/db": src("db"),
      "@gtmgrid/services/realtime": src("services", "src/realtime/index.ts"),
      "@gtmgrid/services/columns": src("services", "src/columns/index.ts"),
      "@gtmgrid/services": src("services"),
      "@gtmgrid/email/lifecycle": src("email", "src/lifecycle/index.ts"),
      "@gtmgrid/email": src("email"),
      "@gtmgrid/auth/party-token": src("auth", "src/party-token.ts"),
      "@gtmgrid/auth": src("auth"),
      "@gtmgrid/pipelines/variables": src("pipelines", "src/variables.ts"),
      "@gtmgrid/pipelines/binding": src("pipelines", "src/binding.ts"),
      "@gtmgrid/pipelines/template-text": src("pipelines", "src/template-text.ts"),
      "@gtmgrid/pipelines": src("pipelines"),
      "@gtmgrid/analytics": src("analytics"),
      "@gtmgrid/cloud": src("cloud"),
      "@gtmgrid/engine": src("engine"),
    },
  },
});
