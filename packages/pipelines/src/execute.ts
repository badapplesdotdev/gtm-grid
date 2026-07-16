/**
 * Shared pipeline node executor + template resolution.
 *
 * This is the single implementation of "how a node runs": template resolution
 * plus per-node dispatch. Both the cloud worker
 * (`apps/web/lib/inngest/functions/pipeline-runs.ts`) and the local desktop
 * sidecar (`packages/server/src/index.ts`) build their executor from this
 * factory so their behaviour can never drift apart.
 *
 * The package stays engine-free: the engine capabilities a node needs
 * (`dispatch`, `providerMap`, `runFunction`) are injected structurally, so
 * `@gtmgrid/pipelines` keeps its zod-only dependency footprint.
 */

import { pipelineTemplateText } from "./template-text.js";
import type {
  PipelineNodeExecutionContext,
  PipelineNodeExecutionResult,
  PipelineNodeExecutor,
} from "./types.js";

/** Resolve a dotted path (`a.b.c`) against a scope object. */
export function pipelinePathValue(source: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>(
    (value, key) =>
      typeof value === "object" && value !== null
        ? (value as Record<string, unknown>)[key]
        : undefined,
    source,
  );
}

/**
 * Resolve `{{ path }}` templates inside a value tree.
 *
 * A string that is *exactly* one template keeps the referenced value's native
 * type (so a tool param can stay a number/object); any other string does
 * textual substitution. Arrays and objects are resolved recursively.
 */
export function resolvePipelineTemplates(
  value: unknown,
  scope: Readonly<Record<string, unknown>>,
): unknown {
  if (typeof value === "string") {
    const exact = value.match(/^\{\{\s*([^}]+?)\s*\}\}$/);
    if (exact?.[1] !== undefined) return pipelinePathValue(scope, exact[1]);
    return value.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, path: string) =>
      String(pipelinePathValue(scope, path) ?? ""),
    );
  }
  if (Array.isArray(value)) return value.map((item) => resolvePipelineTemplates(item, scope));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, resolvePipelineTemplates(item, scope)]),
    );
  }
  return value;
}

/** Resolve `{{ path }}` templates inside a formula/condition expression,
 * JSON-encoding each value so it lands as a literal in the evaluated code. */
export function resolvePipelineExpression(
  expression: string,
  scope: Readonly<Record<string, unknown>>,
): string {
  return expression.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, path: string) =>
    JSON.stringify(pipelinePathValue(scope, path)) ?? "undefined",
  );
}

/** Engine capabilities a node executor needs, injected structurally so this
 * package never imports `@gtmgrid/engine`. The shapes mirror the engine's
 * `SandboxDispatch`, `Registry.providerMap`, and `runFunction` exactly. */
export type PipelineExecutorDispatch = (
  provider: string,
  method: string,
  input: Record<string, unknown>,
) => Promise<unknown>;

export interface PipelineExecutorEngine {
  readonly dispatch: PipelineExecutorDispatch;
  readonly providerMap: () => Record<string, string[]>;
  readonly runFunction: (args: {
    readonly code: string;
    readonly inputs: Record<string, unknown>;
    readonly providers: Record<string, string[]>;
    readonly dispatch: PipelineExecutorDispatch;
  }) => Promise<unknown>;
}

/** Build the scope objects a node resolves its config/expression against. */
function scopesFor(context: PipelineNodeExecutionContext): {
  readonly scope: Record<string, unknown>;
  readonly inputs: Record<string, unknown>;
} {
  return {
    scope: {
      ...context.rootInput,
      inputs: context.rootInput,
      input: context.rootInput,
      upstream: context.upstream,
      nodes: context.previousOutputs,
    },
    inputs: { ...context.rootInput, ...context.upstream, nodes: context.previousOutputs },
  };
}

/**
 * The single node-execution implementation used by both the cloud worker and
 * the local sidecar. `unsupportedMessage` lets each caller phrase the "node
 * type not executable here" error in its own voice.
 */
export function makePipelineNodeExecutor(
  engine: PipelineExecutorEngine,
  options: { readonly unsupportedMessage?: (nodeType: string) => string } = {},
): PipelineNodeExecutor {
  const unsupported =
    options.unsupportedMessage ??
    ((nodeType: string) => `Pipeline node type ${nodeType} is not executable.`);

  return {
    execute: async (
      context: PipelineNodeExecutionContext,
    ): Promise<PipelineNodeExecutionResult> => {
      const { scope, inputs } = scopesFor(context);
      const node = context.node;

      if (node.type === "tool") {
        return {
          output: await engine.dispatch(
            node.config.provider,
            node.config.method,
            resolvePipelineTemplates(node.config.params, scope) as Record<string, unknown>,
          ),
        };
      }

      if (node.type === "ai") {
        const resolved = resolvePipelineTemplates(
          {
            provider: node.config.provider,
            model: node.config.model,
            prompt: node.config.prompt,
            system: node.config.system,
          },
          scope,
        ) as Record<string, unknown>;
        const prompt = pipelineTemplateText(resolved.prompt);
        if (!prompt.trim()) {
          throw new Error(
            `AI node ${node.name} prompt resolved to an empty value. Choose a populated source column or earlier node output.`,
          );
        }
        const output = await engine.dispatch("ai", "generate", {
          ...resolved,
          prompt,
          ...(resolved.system === undefined
            ? {}
            : { system: pipelineTemplateText(resolved.system) }),
        });
        return {
          output:
            node.config.responseFormat !== "json" &&
            typeof output === "object" &&
            output !== null &&
            "text" in output
              ? (output as { text: unknown }).text
              : output,
        };
      }

      if (node.type === "http") {
        return {
          output: await engine.dispatch(
            "http",
            "request",
            resolvePipelineTemplates(node.config, scope) as Record<string, unknown>,
          ),
        };
      }

      if (node.type === "formula" || node.type === "condition") {
        const expression = resolvePipelineExpression(node.config.expression, scope);
        const output = await engine.runFunction({
          code: `function(inputs) { with (inputs) { return (${expression}); } }`,
          inputs,
          providers: engine.providerMap(),
          dispatch: engine.dispatch,
        });
        return node.type === "condition"
          ? { output, branch: output ? "true" : "false" }
          : { output };
      }

      if (node.type === "code") {
        return {
          output: await engine.runFunction({
            code: node.config.source,
            inputs,
            providers: engine.providerMap(),
            dispatch: engine.dispatch,
          }),
        };
      }

      throw new Error(unsupported(node.type));
    },
  };
}
