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
  methods: [
    {
      id: "getUser",
      label: "Get GitHub User",
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
