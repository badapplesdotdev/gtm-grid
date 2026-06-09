// SSRF guard for connector HTTP — used when connectors run on SHARED server
// infrastructure (the Vercel webhook-enrichment worker), where a workspace member
// can upload a custom connector manifest with an arbitrary `baseUrl`. Without a
// guard that manifest could point the server at internal/link-local addresses
// (e.g. the cloud metadata endpoint 169.254.169.254, RFC-1918 hosts, or loopback)
// and turn the worker into an SSRF proxy.
//
// LOCAL runs (the desktop sidecar) are NOT guarded: there the connector call runs
// on the user's OWN machine against their OWN network, so a self-hosted connector
// on localhost/LAN is legitimate and self-targeted. The guard is opt-in per run
// via `EngineConfig.guardSsrf` (set true only on server-side run paths).
//
// The check resolves the host's DNS and rejects if ANY resolved address is
// private/reserved — so a public-looking name that points at an internal IP is
// caught, not just literal-IP `baseUrl`s. A residual TOCTOU window remains (DNS
// could change between this check and the socket connect); pairing this with
// `redirect: "error"` at the fetch call closes the redirect-amplification path,
// and pinning the connect IP would close TOCTOU fully if ever needed.

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/** Raised when a connector URL is blocked by the SSRF guard (server-side runs). */
export class SsrfBlockedError extends Error {
  readonly _tag = "SsrfBlockedError";
  constructor(message: string) {
    super(message);
    this.name = "SsrfBlockedError";
  }
}

/** Whether an IPv4 literal falls in a private/reserved (non-public) range. */
function isBlockedIpv4(ip: string): boolean {
  const parts = ip.split(".").map((p) => Number(p));
  if (
    parts.length !== 4 ||
    parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)
  ) {
    return true; // malformed → block (defensive)
  }
  const [a, b, c] = parts as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // 10/8 private
  if (a === 127) return true; // 127/8 loopback
  if (a === 169 && b === 254) return true; // 169.254/16 link-local (incl. cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12 private
  if (a === 192 && b === 168) return true; // 192.168/16 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0/24 IETF protocol
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15 benchmarking
  if (a >= 224) return true; // 224/4 multicast + 240/4 reserved + 255.255.255.255
  return false;
}

/** Whether an IPv6 literal falls in a private/reserved (non-public) range. */
function isBlockedIpv6(ip: string): boolean {
  const norm = ip.toLowerCase().split("%")[0]; // drop any zone id (`fe80::1%eth0`)
  if (norm === "::1" || norm === "::") return true; // loopback / unspecified
  // IPv4-mapped (`::ffff:a.b.c.d`) — evaluate the embedded IPv4.
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(norm);
  if (mapped) return isBlockedIpv4(mapped[1]);
  const first = norm.split(":")[0];
  if (first.startsWith("fc") || first.startsWith("fd")) return true; // fc00::/7 unique-local
  if (["fe8", "fe9", "fea", "feb"].some((p) => first.startsWith(p))) return true; // fe80::/10 link-local
  if (first.startsWith("ff")) return true; // ff00::/8 multicast
  return false;
}

/**
 * Whether `ip` (an IPv4 or IPv6 literal) is a private/reserved address a
 * server-side connector must not reach. A string that is not a valid IP is
 * treated as blocked (defensive — the caller only passes resolved addresses).
 */
export function isBlockedIp(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return isBlockedIpv4(ip);
  if (kind === 6) return isBlockedIpv6(ip);
  return true;
}

/** Injection seam for tests: resolve a hostname to its IP addresses. */
export interface SsrfOptions {
  readonly resolve?: (hostname: string) => Promise<readonly string[]>;
}

const defaultResolve = async (hostname: string): Promise<readonly string[]> => {
  const records = await lookup(hostname, { all: true });
  return records.map((r) => r.address);
};

/**
 * Assert that `rawUrl` is safe for a server-side connector to fetch: an
 * `http(s)` scheme whose host is neither a private/reserved IP literal nor a name
 * that resolves to one. Throws {@link SsrfBlockedError} otherwise. Pair the call
 * site with `redirect: "error"` so a 3xx into a private host cannot bypass it.
 */
export async function assertPublicUrl(
  rawUrl: string | URL,
  opts: SsrfOptions = {},
): Promise<void> {
  let url: URL;
  try {
    url = typeof rawUrl === "string" ? new URL(rawUrl) : rawUrl;
  } catch {
    throw new SsrfBlockedError("blocked malformed connector URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SsrfBlockedError(
      `blocked non-http(s) connector URL scheme: ${url.protocol}`,
    );
  }
  const host = url.hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets

  // Literal IP host: no DNS — check it directly.
  if (isIP(host) !== 0) {
    if (isBlockedIp(host)) {
      throw new SsrfBlockedError(`blocked private/reserved address: ${host}`);
    }
    return;
  }

  // Named host: resolve and require EVERY address to be public, so a public-
  // looking name pointing at an internal IP (or `localhost`) is rejected.
  const resolve = opts.resolve ?? defaultResolve;
  let addrs: readonly string[];
  try {
    addrs = await resolve(host);
  } catch {
    throw new SsrfBlockedError(`blocked: could not resolve host ${host}`);
  }
  if (addrs.length === 0) {
    throw new SsrfBlockedError(`blocked: host ${host} resolved to no addresses`);
  }
  for (const addr of addrs) {
    if (isBlockedIp(addr)) {
      throw new SsrfBlockedError(
        `blocked: host ${host} resolves to private/reserved address ${addr}`,
      );
    }
  }
}
