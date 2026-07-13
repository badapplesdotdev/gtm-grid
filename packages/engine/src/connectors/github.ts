// Real, keyless HTTP connector — proves the full network + credential-injection path
// with live data. Works anonymously; if a "github" credential with { token } exists,
// it's injected as a Bearer token (higher rate limit) — demonstrating the auth path.

import { z } from "zod";
import { defineHttpConnector } from "./http.js";

export const githubConnector = defineHttpConnector({
  id: "github",
  name: "GitHub",
  category: "enrichment",
  baseUrl: "https://api.github.com",
  auth: { type: "apiKey", header: "authorization" },
  secretKey: "token",
  // GitHub REST: authed 5,000 req/hr (anon only 60/hr), plus a secondary limit of
  // ≤100 concurrent requests. Pace conservatively (1 req/s, ≤2 in flight) — well
  // under both ceilings and safe for the anonymous case. GitHub honours `retry-after`.
  rateLimit: { rps: 1, concurrency: 2 },
  methods: [
    {
      id: "getUser",
      label: "Get GitHub User",
      category: "Enrich people",
      description:
        "Fetch a public GitHub user profile by username. Returns login, name, company, bio, blog, location, followers, and public_repos.",
      verb: "GET",
      path: "/users/{username}",
      input: z.object({
        username: z.string().describe("GitHub login/username, e.g. 'torvalds'"),
      }),
      credits: 1,
    },
  ],
});
