import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// `@gtmgrid/services` holds the Effect repositories + domain services that the
// tRPC routers build on. Every suite runs OFFLINE: services are exercised
// against their in-memory Test Layers (no live Postgres), so the default "node"
// environment runs them directly with no setup.

const src = (pkg: string, entry = "src/index.ts") =>
  fileURLToPath(new URL(`../${pkg}/${entry}`, import.meta.url));

export default defineConfig({
  test: {
    name: "services",
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
  resolve: {
    /**
     * Resolve sibling workspace packages straight to their SOURCE.
     *
     * Not a workaround for a build step — these packages have no build; their
     * package.json `exports` already point at `./src/*.ts`, so this alias is
     * semantically identical to what a correct pnpm link provides.
     *
     * It exists because a git worktree shares the MAIN checkout's `node_modules`,
     * where the `@gtmgrid/*` links may be absent or point at a DIFFERENT
     * worktree. Without it every suite touching a repository fails to collect
     * with "Cannot find package '@gtmgrid/db'" — which reads like a broken import
     * rather than an environment quirk, and buries real failures in noise.
     *
     * Harmless where the install IS correct: it resolves to the same files pnpm
     * would have linked.
     */
    alias: {
      // Longest-prefix first: Vite matches string aliases by prefix, so a bare
      // "@gtmgrid/db" listed above "@gtmgrid/db/client" would swallow the subpath.
      "@gtmgrid/db/client": src("db", "src/client.ts"),
      "@gtmgrid/db": src("db"),
      "@gtmgrid/cloud": src("cloud"),
      "@gtmgrid/pipelines/variables": src("pipelines", "src/variables.ts"),
      "@gtmgrid/pipelines/binding": src("pipelines", "src/binding.ts"),
      "@gtmgrid/pipelines/template-text": src("pipelines", "src/template-text.ts"),
      "@gtmgrid/pipelines": src("pipelines"),
      "@gtmgrid/auth/party-token": src("auth", "src/party-token.ts"),
      "@gtmgrid/auth": src("auth"),
      "@gtmgrid/email/lifecycle": src("email", "src/lifecycle/index.ts"),
      "@gtmgrid/email": src("email"),
    },
  },
});
