// Built-in AI Generate connector. Bring-your-own-key (Anthropic, OpenAI,
// OpenRouter, or a Hermes gateway), resolved from the engine's AI provider
// config — never leaves the machine.

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { Connector, MethodContext, AiConfig } from "../types.js";

// Default Hermes gateway base URL — the user's SSH tunnel to the mac-mini
// api_server (localhost:18642 -> mac-mini:8642). Overridable per connection;
// for a gateway running locally, point it at :8642 directly.
export const DEFAULT_HERMES_BASE_URL = "http://localhost:18642/v1";

const generateInput = z.object({
  prompt: z.string().describe("The prompt. Use {{Column Name}} in the column mapping to inject row values."),
  system: z.string().optional().describe("Optional system instruction."),
  model: z.string().optional().describe("Override the model id (must belong to the connected provider)."),
  provider: z
    .enum(["anthropic", "openai", "openrouter", "hermes"])
    .optional()
    .describe("Pin the AI provider. If omitted, it's inferred from the model id (e.g. 'hermes-*' -> Hermes)."),
  maxTokens: z.coerce.number().optional().describe("Max output tokens (default 512)."),
});

/**
 * Per-attempt request timeout and retry budget handed to the vendor SDKs. Both
 * `@anthropic-ai/sdk` and `openai` do their OWN capped exponential backoff with
 * jitter and honour `retry-after`, so the SDK is the single owner of retry on the
 * AI path — we only raise the defaults (SDK default is `maxRetries: 2`). Do NOT
 * wrap these calls in `fetchWithRetry` as well (that would nest two retry loops).
 */
const AI_MAX_RETRIES = 4;
const AI_TIMEOUT_MS = 60_000;

export const aiConnector: Connector = {
  id: "ai",
  name: "AI",
  category: "ai",
  auth: null,
  // Moderate default throttle: AI keys are bring-your-own and tier-dependent, so a
  // conservative pace (3 req/s, ≤5 in flight) keeps a large run under typical
  // tier-1 RPM limits without clamping it to the tight unknown-provider default.
  rateLimit: { rps: 3, concurrency: 5 },
  methods: [
    {
      id: "generate",
      label: "AI Generate",
      description: "Generate text with the connected AI model from a prompt. Returns { text }.",
      inputSchema: zodToJsonSchema(generateInput, "generate") as Record<string, unknown>,
      batchSize: 1,
      credits: 1,
      run: async (raw: Record<string, unknown>, ctx: MethodContext) => {
        const input = generateInput.parse(raw);
        const all = ctx.aiProviders?.length ? ctx.aiProviders : ctx.ai ? [ctx.ai] : [];
        if (all.length === 0) {
          // No BYO key — fall back to the user's already-authenticated coding
          // agent (Claude Code / Codex) so AI columns work off the model they're
          // already using. If no agent is available either, the original error
          // tells them to connect a key.
          if (ctx.aiFallback) {
            const text = await ctx.aiFallback({
              prompt: input.prompt,
              system: input.system,
              model: input.model,
            });
            return { text };
          }
          throw new Error(
            "No AI provider connected. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or OPENROUTER_API_KEY.",
          );
        }
        const wantModel = input.model?.trim();
        // Route to the provider that owns the requested model. An explicit
        // `provider` wins; otherwise infer from the model id. Order preserves the
        // existing rules: namespaced ids ("vendor/model") are OpenRouter and
        // "claude-*" is Anthropic — a bare "hermes-*" id is the Hermes gateway,
        // everything else (gpt-*, o*, etc.) is OpenAI. When in doubt, set `provider`.
        const wantProvider: AiConfig["provider"] | undefined =
          input.provider ??
          (wantModel
            ? wantModel.includes("/")
              ? "openrouter"
              : wantModel.startsWith("claude")
                ? "anthropic"
                : /^hermes/i.test(wantModel)
                  ? "hermes"
                  : "openai"
            : undefined);
        const ai =
          (wantProvider && all.find((a) => a.provider === wantProvider)) || ctx.ai || all[0];
        const maxTokens = input.maxTokens ?? 512;
        const model = wantModel || ai.model;

        if (ai.provider === "anthropic") {
          const client = new Anthropic({
            apiKey: ai.apiKey,
            maxRetries: AI_MAX_RETRIES,
            timeout: AI_TIMEOUT_MS,
          });
          const msg = await client.messages.create({
            model,
            max_tokens: maxTokens,
            system: input.system,
            messages: [{ role: "user", content: input.prompt }],
          });
          const text = msg.content
            .filter((b): b is Anthropic.TextBlock => b.type === "text")
            .map((b) => b.text)
            .join("");
          return { text };
        }

        // OpenRouter and Hermes are OpenAI-API-compatible — same client, different
        // base URL. Hermes is a local/LAN gateway so its base URL is configurable
        // (defaults to the tunnel port); it accepts any bearer when the gateway has
        // no API_SERVER_KEY set, so fall back to a placeholder token.
        const baseURL =
          ai.provider === "openrouter"
            ? "https://openrouter.ai/api/v1"
            : ai.provider === "hermes"
              ? ai.baseURL || DEFAULT_HERMES_BASE_URL
              : undefined;
        const client = new OpenAI({
          apiKey: ai.apiKey || "hermes",
          maxRetries: AI_MAX_RETRIES,
          timeout: AI_TIMEOUT_MS,
          ...(baseURL ? { baseURL } : {}),
        });
        const r = await client.chat.completions.create({
          model,
          max_tokens: maxTokens,
          messages: [
            ...(input.system ? [{ role: "system" as const, content: input.system }] : []),
            { role: "user" as const, content: input.prompt },
          ],
        });
        return { text: r.choices[0]?.message?.content ?? "" };
      },
    },
  ],
};
