// Unit tests for the AI Generate connector's provider routing — focused on the
// Hermes gateway path (OpenAI-compatible, configurable base URL) without making
// any network calls. The `openai` / `@anthropic-ai/sdk` clients are mocked so we
// can assert exactly how each request is dispatched.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AiConfig, MethodContext } from "../types.js";

// vi.mock factories are hoisted above imports, so the spies they reference must
// be created with vi.hoisted (not plain top-level consts).
const { openaiCtor, createMock, anthropicCreate } = vi.hoisted(() => ({
  openaiCtor: vi.fn(),
  createMock: vi.fn(),
  anthropicCreate: vi.fn(),
}));

vi.mock("openai", () => ({
  default: vi.fn().mockImplementation((opts: unknown) => {
    openaiCtor(opts);
    return { chat: { completions: { create: createMock } } };
  }),
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(() => ({ messages: { create: anthropicCreate } })),
}));

import { aiConnector } from "./ai.js";

const generate = aiConnector.methods.find((m) => m.id === "generate")!;
const ctx = (aiProviders: AiConfig[]): MethodContext => ({ secrets: {}, aiProviders });

const HERMES: AiConfig = {
  provider: "hermes",
  apiKey: "gw-key",
  model: "hermes-4",
  baseURL: "http://gw:18642/v1",
};
const OPENAI: AiConfig = { provider: "openai", apiKey: "oa-key", model: "gpt-4o-mini" };

beforeEach(() => {
  openaiCtor.mockClear();
  createMock.mockClear();
  anthropicCreate.mockClear();
  createMock.mockResolvedValue({ choices: [{ message: { content: "ok" } }] });
});

describe("ai.generate — Hermes routing", () => {
  it("routes a bare hermes-* model to the Hermes gateway base URL", async () => {
    const out = await generate.run({ prompt: "hi", model: "hermes-4" }, ctx([OPENAI, HERMES]));
    expect(openaiCtor).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "gw-key", baseURL: "http://gw:18642/v1" }),
    );
    expect(createMock).toHaveBeenCalledWith(expect.objectContaining({ model: "hermes-4" }));
    expect(out).toEqual({ text: "ok" });
  });

  it("honors an explicit provider override even for a non-hermes model id", async () => {
    await generate.run(
      { prompt: "hi", model: "claude-opus-4.8", provider: "hermes" },
      ctx([OPENAI, HERMES]),
    );
    expect(openaiCtor).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: "http://gw:18642/v1" }),
    );
    // It must NOT have been dispatched to the Anthropic client.
    expect(anthropicCreate).not.toHaveBeenCalled();
  });

  it("does not send OpenAI traffic to the Hermes base URL", async () => {
    await generate.run({ prompt: "hi", model: "gpt-4o" }, ctx([OPENAI, HERMES]));
    const callOpts = openaiCtor.mock.calls.at(-1)?.[0] as { apiKey?: string; baseURL?: string } | undefined;
    expect(callOpts?.apiKey).toBe("oa-key");
    expect(callOpts?.baseURL).toBeUndefined();
  });

  it("falls back to the default tunnel base URL when none is stored", async () => {
    await generate.run(
      { prompt: "hi", model: "hermes-4" },
      ctx([{ provider: "hermes", apiKey: "k", model: "hermes-4" }]),
    );
    expect(openaiCtor).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: "http://localhost:18642/v1" }),
    );
  });

  it("uses a placeholder bearer when the gateway needs no key", async () => {
    await generate.run(
      { prompt: "hi", provider: "hermes" },
      ctx([{ provider: "hermes", apiKey: "", model: "hermes-4", baseURL: "http://gw/v1" }]),
    );
    expect(openaiCtor).toHaveBeenCalledWith(expect.objectContaining({ apiKey: "hermes" }));
  });
});

describe("ai.generate — no-key agent fallback", () => {
  it("routes through aiFallback (the user's agent model) when no provider is connected", async () => {
    const aiFallback = vi.fn().mockResolvedValue("agent says hi");
    const out = await generate.run(
      { prompt: "hi", system: "be terse" },
      { secrets: {}, aiProviders: [], aiFallback },
    );
    expect(aiFallback).toHaveBeenCalledWith({ prompt: "hi", system: "be terse", model: undefined });
    expect(out).toEqual({ text: "agent says hi" });
    // It must NOT have touched a real provider client.
    expect(openaiCtor).not.toHaveBeenCalled();
    expect(anthropicCreate).not.toHaveBeenCalled();
  });

  it("throws the connect-a-key error when there is neither a provider nor a fallback", async () => {
    await expect(generate.run({ prompt: "hi" }, { secrets: {}, aiProviders: [] })).rejects.toThrow(
      /No AI provider connected/,
    );
  });
});
