import { afterEach, describe, expect, it, vi } from "vitest";
import { BUNDLED_MANIFESTS } from "../bundled-manifests.generated.js";
import { connectorFromManifest, parseManifest } from "./manifest.js";

const raw = BUNDLED_MANIFESTS.find(
  (item) => (item as { id?: string }).id === "linear",
) as Record<string, unknown> | undefined;

const manifest = parseManifest(raw);

afterEach(() => vi.restoreAllMocks());

describe("Linear bundled connector", () => {
  it("covers every active root operation in Linear's public schema", () => {
    expect(manifest.methods).toHaveLength(517);
    expect(manifest.methods.filter((method) => method.id.startsWith("query_"))).toHaveLength(157);
    expect(manifest.methods.filter((method) => method.id.startsWith("mutation_"))).toHaveLength(359);
    expect(manifest.methods.filter((method) => method.id === "executeGraphQL")).toHaveLength(1);
    expect(new Set(manifest.methods.map((method) => method.id)).size).toBe(517);
    expect(manifest.auth).toMatchObject({
      header: "Authorization",
      credentialLabel: "personal API key",
      scheme: "",
    });
    expect(manifest.rateLimit).toEqual({ rpm: 40, concurrency: 2 });
    expect(manifest.logo).toMatch(/^data:image\/svg\+xml;base64,/);
  });

  it("contains self-contained input schemas and official source links", () => {
    for (const method of manifest.methods) {
      expect(method.input?.type, method.id).toBe("object");
      expect(method.description, method.id).toContain("https://linear.app/developers/graphql");
      expect(JSON.stringify(method.input), method.id).not.toContain('"$ref"');
    }
  });

  it("executes a generated query with raw personal-key auth", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response('{"data":{"viewer":{"id":"usr_1","name":"Morgan"}}}', {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const method = connectorFromManifest(manifest).methods.find((item) => item.id === "query_viewer")!;

    await expect(method.run({}, { secrets: { apiKey: "lin_api_key" } })).resolves.toMatchObject({ id: "usr_1" });

    expect(String(fetchSpy.mock.calls[0]![0])).toBe("https://api.linear.app/graphql");
    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe("lin_api_key");
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    const body = JSON.parse(String(init.body));
    expect(body.operationName).toBe("query_viewer");
    expect(body.variables).toEqual({});
    expect(body.query).toContain("query query_viewer");
    expect(body.query).toContain("viewer");
  });

  it("declares mutation variables from the live schema and returns the root payload", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response('{"data":{"issueCreate":{"success":true,"issue":{"id":"issue_1","identifier":"ENG-1"}}}}', {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const method = connectorFromManifest(manifest).methods.find((item) => item.id === "mutation_issueCreate")!;
    const input = { input: { title: "Ship Linear", teamId: "team_1" } };

    await expect(method.run(input, { secrets: { apiKey: "lin_api_key" } })).resolves.toMatchObject({
      success: true,
      issue: { identifier: "ENG-1" },
    });

    const body = JSON.parse(String((fetchSpy.mock.calls[0]![1] as RequestInit).body));
    expect(body.query).toContain("mutation mutation_issueCreate($input: IssueCreateInput!)");
    expect(body.query).toContain("issueCreate(input: $input)");
    expect(body.variables).toEqual(input);
  });

  it("surfaces GraphQL errors even when Linear returns HTTP 200", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response('{"errors":[{"message":"Variable input is invalid","extensions":{"code":"BAD_USER_INPUT"}}]}', {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const method = connectorFromManifest(manifest).methods.find((item) => item.id === "mutation_issueCreate")!;

    await expect(method.run({ input: {} }, { secrets: { apiKey: "lin_api_key" } })).rejects.toThrow(
      "Linear mutation_issueCreate GraphQL BAD_USER_INPUT: Variable input is invalid",
    );
  });

  it("passes custom GraphQL documents and variables through safely", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response('{"data":{"issue":{"id":"issue_1"}}}', {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const method = connectorFromManifest(manifest).methods.find((item) => item.id === "executeGraphQL")!;
    const query = "query OneIssue($id: String!) { issue(id: $id) { id } }";

    await expect(method.run(
      { query, variables: { id: "ENG-1" }, operationName: "OneIssue" },
      { secrets: { apiKey: "lin_api_key" } },
    )).resolves.toEqual({ issue: { id: "issue_1" } });

    expect(JSON.parse(String((fetchSpy.mock.calls[0]![1] as RequestInit).body))).toEqual({
      query,
      variables: { id: "ENG-1" },
      operationName: "OneIssue",
    });
  });
});
