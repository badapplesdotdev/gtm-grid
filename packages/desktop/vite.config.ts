import { readFileSync } from "node:fs";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The shipped app version of record (bumped by changesets at release). Inlined as
// __APP_VERSION__ so it renders in both the Tauri app and the browser dev build.
const appVersion = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf-8"),
).version as string;

// Tauri expects a fixed port and no clearing of the screen.
export default defineConfig(({ command, mode }) => {
  // The app is cloud-only: it always talks to an apps/web backend (our hosted
  // cloud, or a self-hosted Postgres + apps/web stack). VITE_API_URL is therefore
  // REQUIRED. Fail a release `vite build` early — rather than shipping a bundle
  // that throws at boot (cloud/client.tsx also guards at module load) — so a
  // build can never be cut without it. Dev (`serve`) stays permissive.
  const env = loadEnv(mode, process.cwd(), "");
  const apiUrl = process.env.VITE_API_URL ?? env.VITE_API_URL;
  if (command === "build" && !apiUrl) {
    throw new Error(
      "VITE_API_URL is required to build the desktop app — it is cloud-only. " +
        "Set it to your apps/web base URL (e.g. https://app.gtmgrid.dev or http://localhost:3000).",
    );
  }
  // BUILD CHANNEL, derived from the backend the bundle is being pointed at — NOT
  // a separate flag. The endpoints are baked in at build time, so a staging app
  // and a production app are different binaries that look identical once
  // installed; the whole point of the suffix is telling them apart. Deriving it
  // from VITE_API_URL means the label CANNOT disagree with reality, whereas a
  // hand-set flag can be forgotten or left stale from the previous build — which
  // is precisely the failure it exists to prevent.
  const host = (() => {
    try {
      return new URL(apiUrl ?? "").host;
    } catch {
      return "";
    }
  })();
  const channel =
    host === "www.gtmgrid.dev" || host === "gtmgrid.dev"
      ? null // production: the bare version, as released
      : host === "staging.gtmgrid.dev"
        ? "staging"
        : "dev"; // localhost, tunnels, preview URLs
  const displayVersion = channel === null ? appVersion : `${appVersion}-${channel}`;

  return {
    plugins: [react(), tailwindcss()],
    clearScreen: false,
    define: { __APP_VERSION__: JSON.stringify(displayVersion) },
    server: { port: 5173, strictPort: true },
    build: {
      outDir: "dist",
      target: "es2021",
      rollupOptions: {
        output: {
          // Split heavy vendor libraries into their own chunks so the initial
          // app chunk stays small and the >500 kB single-chunk warning clears.
          // Lazy-loaded panels (see App.tsx React.lazy) are code-split on top of
          // this by the dynamic import()s themselves. (TRI-3287)
          //
          // Function form (rather than the object map) so react/react-dom win
          // their own chunk instead of being absorbed into the first react
          // consumer's chunk (e.g. @tanstack/*). Order matters: most specific
          // matches first.
          manualChunks(id) {
            if (!id.includes("node_modules")) return undefined;
            if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) {
              return "react-vendor";
            }
            if (id.includes("@tanstack")) return "tanstack";
            if (id.includes("@trpc")) return "trpc";
            if (/[\\/]node_modules[\\/]effect[\\/]/.test(id)) return "effect";
            return "vendor";
          },
        },
      },
    },
  };
});
