/**
 * SSRF guard tests — the boundary that stops a server-side connector (the Vercel
 * enrichment worker) from being pointed at internal/reserved addresses by an
 * attacker-supplied manifest `baseUrl`.
 */

import { describe, expect, it } from "vitest";
import { assertPublicUrl, isBlockedIp, SsrfBlockedError } from "./ssrf.js";

describe("isBlockedIp", () => {
  it("blocks IPv4 private / loopback / link-local / metadata ranges", () => {
    for (const ip of [
      "127.0.0.1",
      "10.0.0.5",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254", // cloud metadata
      "100.64.0.1", // CGNAT
      "0.0.0.0",
      "224.0.0.1", // multicast
    ]) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
  });

  it("allows public IPv4 addresses", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34"]) {
      expect(isBlockedIp(ip), ip).toBe(false);
    }
  });

  it("blocks IPv6 loopback / ULA / link-local / mapped-private, allows public", () => {
    expect(isBlockedIp("::1")).toBe(true);
    expect(isBlockedIp("fc00::1")).toBe(true);
    expect(isBlockedIp("fd12:3456::1")).toBe(true);
    expect(isBlockedIp("fe80::1")).toBe(true);
    expect(isBlockedIp("::ffff:127.0.0.1")).toBe(true); // IPv4-mapped loopback
    expect(isBlockedIp("2606:4700:4700::1111")).toBe(false); // public (Cloudflare)
  });

  it("treats a non-IP string as blocked (defensive)", () => {
    expect(isBlockedIp("not-an-ip")).toBe(true);
  });
});

describe("assertPublicUrl", () => {
  const resolveTo = (...addrs: string[]) => async () => addrs;

  it("rejects a non-http(s) scheme", async () => {
    await expect(assertPublicUrl("file:///etc/passwd")).rejects.toBeInstanceOf(
      SsrfBlockedError,
    );
    await expect(assertPublicUrl("ftp://example.com")).rejects.toBeInstanceOf(
      SsrfBlockedError,
    );
  });

  it("rejects a literal private/metadata IP host without any DNS", async () => {
    await expect(
      assertPublicUrl("http://169.254.169.254/latest/meta-data/"),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(assertPublicUrl("http://127.0.0.1:8787/")).rejects.toBeInstanceOf(
      SsrfBlockedError,
    );
    await expect(assertPublicUrl("http://[::1]/")).rejects.toBeInstanceOf(
      SsrfBlockedError,
    );
  });

  it("allows a literal public IP host", async () => {
    await expect(assertPublicUrl("https://1.1.1.1/")).resolves.toBeUndefined();
  });

  it("rejects a NAME that resolves to a private address", async () => {
    await expect(
      assertPublicUrl("https://evil.example.com/api", {
        resolve: resolveTo("10.0.0.5"),
      }),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("rejects when ANY resolved address is private (mixed records)", async () => {
    await expect(
      assertPublicUrl("https://mixed.example.com", {
        resolve: resolveTo("93.184.216.34", "169.254.169.254"),
      }),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("allows a name that resolves only to public addresses", async () => {
    await expect(
      assertPublicUrl("https://api.example.com/v1", {
        resolve: resolveTo("93.184.216.34"),
      }),
    ).resolves.toBeUndefined();
  });

  it("blocks a host that resolves to nothing", async () => {
    await expect(
      assertPublicUrl("https://void.example.com", { resolve: resolveTo() }),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
  });
});
