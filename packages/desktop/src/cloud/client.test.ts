/**
 * NEW-path cloud client foundation tests (TRI-3252).
 *
 * Everything here is OFFLINE: no live apps/web server, no Postgres, no network.
 * We assert the foundation pieces this lane ships:
 *   1. CLIENT CONSTRUCTION — the tRPC/auth/react-query clients build without
 *      throwing and the URL helpers derive the right endpoints.
 *   2. FLAG SELECTION — the strangler precedence (`selectCloudPath`) picks the
 *      new path when `VITE_API_URL` is set, else Convex, else local.
 *
 * Token-resolution + OAuth-callback logic live in ./api-auth.test.ts.
 */

import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import {
  authUrl,
  makeAuthClient,
  makeQueryClient,
  makeTrpcClient,
  selectCloudPath,
  trpcUrl,
} from "./client";

describe("trpcUrl / authUrl", () => {
  it("derives the tRPC and Better Auth endpoints from the API base", () => {
    expect(trpcUrl("http://localhost:3000")).toBe(
      "http://localhost:3000/api/trpc",
    );
    expect(authUrl("http://localhost:3000")).toBe(
      "http://localhost:3000/api/auth",
    );
  });

  it("tolerates a trailing slash on the base (no double slash)", () => {
    expect(trpcUrl("https://app.gtmgrid.dev/")).toBe(
      "https://app.gtmgrid.dev/api/trpc",
    );
    expect(authUrl("https://app.gtmgrid.dev///")).toBe(
      "https://app.gtmgrid.dev/api/auth",
    );
  });
});

describe("client construction (offline)", () => {
  // Both clients are PROXY-based: traversing deep method paths (e.g.
  // `client.signIn.social`) lazily probes the server schema over the network, so
  // we assert construction succeeds WITHOUT walking into network-bound paths —
  // the typed method surface is guaranteed by `AppRouter` / the auth plugin
  // types at compile time (the typecheck gate), not at runtime here.
  it("builds a tRPC client without opening a connection", () => {
    const client = makeTrpcClient("http://localhost:3000");
    // tRPC's client is a callable proxy (a function), constructed lazily — no
    // request is made until a procedure is actually called.
    expect(client).toBeTypeOf("function");
  });

  it("builds a Better Auth client without opening a connection", () => {
    const client = makeAuthClient("http://localhost:3000");
    // `useSession` is a real own-property hook (not a network-probed proxy leaf),
    // so reading it neither throws nor opens a connection.
    expect(client.useSession).toBeTypeOf("function");
  });

  it("builds an isolated react-query QueryClient per call", () => {
    const a = makeQueryClient();
    const b = makeQueryClient();
    expect(a).toBeInstanceOf(QueryClient);
    expect(b).toBeInstanceOf(QueryClient);
    expect(a).not.toBe(b);
    // Desktop defaults: no window-focus refetch.
    expect(a.getDefaultOptions().queries?.refetchOnWindowFocus).toBe(false);
  });
});

describe("selectCloudPath — strangler flag precedence", () => {
  it("picks the NEW api path when VITE_API_URL is set (wins over Convex)", () => {
    expect(selectCloudPath("http://localhost:3000", undefined)).toBe("api");
    expect(
      selectCloudPath("http://localhost:3000", "https://x.convex.cloud"),
    ).toBe("api");
  });

  it("falls back to the legacy Convex path when only Convex is set", () => {
    expect(selectCloudPath(undefined, "https://x.convex.cloud")).toBe("convex");
    expect(selectCloudPath("", "https://x.convex.cloud")).toBe("convex");
  });

  it("is local-only (no provider) when neither backend is configured", () => {
    expect(selectCloudPath(undefined, undefined)).toBe("local");
    expect(selectCloudPath("", "")).toBe("local");
  });
});
