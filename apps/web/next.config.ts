import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";

// Marketing site is fully self-contained: it imports no workspace libraries,
// so no `transpilePackages` is needed. Kept minimal on purpose.
const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Pin file tracing to this app so Next doesn't infer the monorepo root from
  // sibling lockfiles (it is self-contained and imports no workspace libs).
  outputFileTracingRoot: fileURLToPath(new URL(".", import.meta.url)),
};

export default nextConfig;
