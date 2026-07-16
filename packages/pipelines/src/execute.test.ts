import { describe, expect, it } from "vitest";
import {
  makePipelineNodeExecutor,
  pipelinePathValue,
  resolvePipelineExpression,
  resolvePipelineTemplates,
  type PipelineExecutorEngine,
  type PipelineNodeExecutionContext,
} from "./index.js";
import type { PipelineNode } from "./types.js";

const context = (
  node: PipelineNode,
  over: Partial<PipelineNodeExecutionContext> = {},
): PipelineNodeExecutionContext => ({
  runId: "run",
  rowId: "row",
  target: "cloud",
  node,
  rootInput: {},
  upstream: {},
  previousOutputs: {},
  ...over,
});

/** Records every dispatch/runFunction call so tests can assert what a node sent. */
function fakeEngine(): PipelineExecutorEngine & {
  readonly calls: { provider: string; method: string; params: Record<string, unknown> }[];
  readonly codeRuns: string[];
} {
  const calls: { provider: string; method: string; params: Record<string, unknown> }[] = [];
  const codeRuns: string[] = [];
  return {
    calls,
    codeRuns,
    dispatch: async (provider, method, params) => {
      calls.push({ provider, method, params });
      if (provider === "ai") return { text: "generated" };
      return { echoed: params };
    },
    providerMap: () => ({}),
    runFunction: async ({ code, inputs }) => {
      codeRuns.push(code);
      // The executor passes a `function(inputs){ with(inputs){ return (expr); } }`
      // source string; build it (non-strict, so `with` is legal) and call it.
      const factory = new Function(`return (${code})`) as () => (inputs: Record<string, unknown>) => unknown;
      return factory()(inputs);
    },
  };
}

describe("pipeline template resolution", () => {
  const scope = { company: "Acme", nested: { score: 42 }, count: 3 };

  it("keeps native types for an exact single template", () => {
    expect(resolvePipelineTemplates("{{ count }}", scope)).toBe(3);
    expect(resolvePipelineTemplates("{{ nested.score }}", scope)).toBe(42);
  });

  it("does textual substitution for mixed strings and missing paths", () => {
    expect(resolvePipelineTemplates("Hi {{ company }} ({{ missing }})", scope)).toBe("Hi Acme ()");
  });

  it("resolves recursively through arrays and objects", () => {
    expect(resolvePipelineTemplates({ a: ["{{ company }}"], b: { c: "{{ count }}" } }, scope)).toEqual({
      a: ["Acme"],
      b: { c: 3 },
    });
  });

  it("JSON-encodes values inside an expression and marks missing as undefined", () => {
    expect(resolvePipelineExpression("x === {{ company }} && y > {{ missing }}", scope)).toBe(
      'x === "Acme" && y > undefined',
    );
  });

  it("reads dotted paths and short-circuits on non-objects", () => {
    expect(pipelinePathValue(scope, "nested.score")).toBe(42);
    expect(pipelinePathValue(scope, "company.nope")).toBeUndefined();
  });
});

describe("makePipelineNodeExecutor", () => {
  it("resolves tool params against the scope before dispatch", async () => {
    const engine = fakeEngine();
    const executor = makePipelineNodeExecutor(engine);
    const node: PipelineNode = {
      id: "t", type: "tool", name: "Enrich", position: { x: 0, y: 0 },
      config: { provider: "clearbit", method: "enrich", params: { domain: "{{ domain }}" } },
    };
    await executor.execute(context(node, { rootInput: { domain: "acme.com" } }));
    expect(engine.calls[0]).toMatchObject({ provider: "clearbit", method: "enrich", params: { domain: "acme.com" } });
  });

  it("rejects an AI node whose prompt resolves to empty", async () => {
    const executor = makePipelineNodeExecutor(fakeEngine());
    const node: PipelineNode = {
      id: "a", type: "ai", name: "Summarize", position: { x: 0, y: 0 },
      config: { prompt: "{{ blank }}" },
    };
    await expect(executor.execute(context(node, { rootInput: { blank: "" } }))).rejects.toThrow(/empty value/);
  });

  it("unwraps AI text output unless responseFormat is json", async () => {
    const executor = makePipelineNodeExecutor(fakeEngine());
    const text = await executor.execute(context({
      id: "a", type: "ai", name: "S", position: { x: 0, y: 0 }, config: { prompt: "Hello" },
    }));
    expect(text.output).toBe("generated");
    const json = await executor.execute(context({
      id: "a", type: "ai", name: "S", position: { x: 0, y: 0 }, config: { prompt: "Hello", responseFormat: "json" },
    }));
    expect(json.output).toEqual({ text: "generated" });
  });

  it("returns a true/false branch for a condition node", async () => {
    const executor = makePipelineNodeExecutor(fakeEngine());
    const node: PipelineNode = {
      id: "c", type: "condition", name: "Qualified", position: { x: 0, y: 0 },
      config: { expression: "{{ score }} > 50" },
    };
    expect((await executor.execute(context(node, { rootInput: { score: 80 } }))).branch).toBe("true");
    expect((await executor.execute(context(node, { rootInput: { score: 10 } }))).branch).toBe("false");
  });

  it("uses the caller-supplied message for an unsupported node type", async () => {
    const executor = makePipelineNodeExecutor(fakeEngine(), {
      unsupportedMessage: (type) => `nope: ${type}`,
    });
    const node = { id: "p", type: "pipeline", name: "Sub", position: { x: 0, y: 0 }, config: { pipelineId: "x", versionId: "y", inputMapping: {} } } as PipelineNode;
    await expect(executor.execute(context(node))).rejects.toThrow("nope: pipeline");
  });
});
