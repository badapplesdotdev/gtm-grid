// Built-in AI Generate connector. Bring-your-own-key (Anthropic, OpenAI, or
// OpenRouter), resolved from the engine's AI provider config — never leaves the
// machine.

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { Connector, MethodContext } from "../types.js";

const generateInput = z.object({
  prompt: z.string().describe("The prompt. Use {{Column Name}} in the column mapping to inject row values."),
  system: z.string().optional().describe("Optional system instruction."),
  model: z.string().optional().describe("Override the model id (must belong to the connected provider)."),
  maxTokens: z.coerce.number().optional().describe("Max output tokens (default 512)."),
});

export const aiConnector: Connector = {
  id: "ai",
  name: "AI",
  category: "ai",
  auth: null,
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
        if (all.length === 0)
          throw new Error(
            "No AI provider connected. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or OPENROUTER_API_KEY.",
          );
        const wantModel = input.model?.trim();
        // Route to the provider that owns the requested model. OpenRouter model
        // ids are namespaced ("vendor/model"); Anthropic models are "claude-*";
        // everything else (gpt-*, o*, etc.) is OpenAI.
        const wantProvider: "anthropic" | "openai" | "openrouter" | undefined = wantModel
          ? wantModel.includes("/")
            ? "openrouter"
            : wantModel.startsWith("claude")
              ? "anthropic"
              : "openai"
          : undefined;
        const ai =
          (wantProvider && all.find((a) => a.provider === wantProvider)) || ctx.ai || all[0];
        const maxTokens = input.maxTokens ?? 512;
        const model = wantModel || ai.model;

        if (ai.provider === "anthropic") {
          const client = new Anthropic({ apiKey: ai.apiKey });
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

        // OpenRouter is OpenAI-API-compatible — same client, different base URL.
        const client = new OpenAI({
          apiKey: ai.apiKey,
          ...(ai.provider === "openrouter" ? { baseURL: "https://openrouter.ai/api/v1" } : {}),
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
