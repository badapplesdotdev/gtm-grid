import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The shipped app version of record (bumped by changesets at release). Inlined as
// __APP_VERSION__ so it renders in both the Tauri app and the browser dev build.
const appVersion = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf-8"),
).version as string;

// Tauri expects a fixed port and no clearing of the screen.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  define: { __APP_VERSION__: JSON.stringify(appVersion) },
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
});
