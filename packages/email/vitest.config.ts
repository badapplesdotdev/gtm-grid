import { defineConfig } from "vitest/config";

// The email package holds the ported Resend seam (sendEmail) + branded
// templates. Tests assert template/gating behaviour with no network and no
// AUTH_RESEND_KEY, so the default "node" environment runs them directly.
export default defineConfig({
  test: {
    name: "email",
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
