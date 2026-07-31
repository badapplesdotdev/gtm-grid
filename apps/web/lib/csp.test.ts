import { describe, expect, it } from "vitest";
import nextConfig from "../next.config";

describe("web Content-Security-Policy", () => {
  it("allows the Google Picker loader from its exact origin", async () => {
    const headers = nextConfig.headers;
    expect(headers).toBeTypeOf("function");
    if (typeof headers !== "function") return;

    const rules = await headers();
    const allHeaders = rules.flatMap((rule) => rule.headers);
    const csp = allHeaders.find((header) => header.key === "Content-Security-Policy")?.value;
    const directives = csp?.split("; ") ?? [];

    expect(csp).toBeDefined();
    expect(directives.find((directive) => directive.startsWith("script-src "))).toContain(
      "https://apis.google.com",
    );
    expect(directives.find((directive) => directive.startsWith("frame-src "))).toContain(
      "https://docs.google.com",
    );
  });
});
