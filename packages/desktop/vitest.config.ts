import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Vitest config for the desktop package. Picked up by the root config's
// `projects` glob so `pnpm test` runs the desktop suites alongside the others.
//
// The React plugin compiles the JSX/TSX our cloud modules pull in transitively
// (e.g. cloud/convex.tsx). Tests here cover client-side LOGIC only (the Effect
// auth orchestration); React component rendering is not unit-tested.
export default defineConfig({
  plugins: [react()],
  test: {
    name: "desktop",
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
