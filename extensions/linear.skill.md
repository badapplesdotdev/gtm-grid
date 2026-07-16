# Linear — Agent Skill
> Linear provides issues, projects, teams, cycles, customers, documents, roadmaps, integrations, webhooks, agents, and workspace administration through GraphQL.

## Connect and authenticate
- Save a Linear **personal API key** in the Linear credential. The connector sends the key directly in `Authorization`; do not add `Bearer `.
- Create a key under Linear Settings → Security & access → Personal API keys. The key acts with the permissions of its owner, so use a dedicated least-privilege account where possible.
- Base URL: `https://api.linear.app/graphql`. Every generated method uses POST with JSON.
- Linear OAuth access tokens require `Authorization: Bearer <token>` and are intentionally separate from this personal-key credential.

## Complete operation coverage
- The connector exposes all **157 active Query fields** as `query_<field>` tools.
- It exposes all **359 active Mutation fields** as `mutation_<field>` tools.
- `executeGraphQL` accepts a complete document, variables, and optional operation name for custom selection sets and future schema fields.
- Deprecated schema fields are omitted. Re-run `pnpm --filter @gtmgrid/engine gen:linear` to refresh against Linear's public introspection schema.

## Common read workflows
- `query_viewer` — confirm the authenticated user.
- `query_teams` / `query_team` — list teams or retrieve one team.
- `query_issues` / `query_issue` — filter, paginate, or retrieve issues. `query_issue.id` accepts a UUID or issue identifier such as `ENG-123`.
- `query_projects`, `query_cycles`, `query_customers`, and `query_documents` — browse major workspace records.
- Collection queries accept connection arguments such as `first`, `after`, `last`, and `before`. Follow `pageInfo.endCursor`; Linear defaults pages to 50 items.
- Use `filter` and `includeArchived` rather than polling broad collections.

## Common write workflows
1. Resolve IDs with query methods before creating or updating records.
2. `mutation_issueCreate` requires `input.teamId`; provide a title and any optional assignee, project, cycle, label, state, priority, or due-date fields.
3. `mutation_issueUpdate` requires both `id` and `input`.
4. `mutation_commentCreate` adds comments using its generated `CommentCreateInput` schema.
5. Confirm destructive or administrative actions explicitly before invoking methods whose names include `delete`, `archive`, `remove`, `revoke`, or workspace/integration configuration changes.

## GraphQL behavior and errors
- Linear can return HTTP 200 with an `errors` array. The connector checks that array and throws instead of silently returning partial data.
- Generated tools use a safe default selection. Use `executeGraphQL` when a workflow needs a different or deeper selection set.
- A GraphQL response may contain partial `data` alongside `errors`; the connector treats any error as a failed cell so bad partial results are not stored unnoticed.
- `RATELIMITED` is a GraphQL error and can arrive with HTTP 400. Retries honor upstream retry headers for HTTP throttling.

## Limits and event-driven design
- The connector conservatively schedules at 40 requests/minute and two concurrent requests, within Linear's published personal-key request allowance.
- Query complexity has a per-request maximum and an hourly allowance. Ask only for fields needed by the workflow and paginate large collections.
- Prefer Linear webhooks over polling for ongoing issue/project changes. Webhook endpoints are also available through the generated query and mutation catalog.
- Linear uses a leaky-bucket rate limiter; spread bulk work instead of sending bursts.

## Official documentation
- GraphQL endpoint and authentication: https://linear.app/developers/graphql
- OAuth 2.0: https://linear.app/developers/oauth-2-0-authentication
- Pagination: https://linear.app/developers/pagination
- Filtering: https://linear.app/developers/filtering
- Rate limiting and complexity: https://linear.app/developers/rate-limiting
- Webhooks: https://linear.app/developers/webhooks
- Public schema reference: https://studio.apollographql.com/public/Linear-API/schema/reference?variant=current
