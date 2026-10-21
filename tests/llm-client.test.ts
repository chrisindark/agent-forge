import { describe, expect, it, vi } from "vitest";
import { LlmClient } from "../src/core/llm-client.js";
import { GatewayError } from "../src/core/errors.js";
import type { Message } from "../src/core/types.js";

function completion(body: Record<string, unknown>, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

const baseCompletion = {
  model: "openai/gpt-oss-20b",
  choices: [{ message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
};

function makeClient(fetchImpl: typeof fetch, extraBody?: Record<string, unknown>): LlmClient {
  return new LlmClient({
    baseUrl: "http://localhost:8000",
    apiKey: "eg_test",
    extraBody: { service_name: "groq", ...extraBody },
    fetchImpl,
  });
}

const messages: Message[] = [{ role: "user", content: "hi" }];

describe("LlmClient.chat", () => {
  it("sends the SPEC §6 body with X-API-Key and a per-call X-Request-ID", async () => {
    const fetchImpl = vi.fn(async () => completion(baseCompletion)) as unknown as typeof fetch;
    const client = makeClient(fetchImpl);

    await client.chat({ model: "openai/gpt-oss-20b", messages, temperature: 0.2, maxTokens: 1024 });

    const [url, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]!;
    expect(url).toBe("http://localhost:8000/api/v1/chat/completions");
    const headers = init.headers as Record<string, string>;
    expect(headers["X-API-Key"]).toBe("eg_test");
    expect(headers["X-Request-ID"]).toMatch(/^af-/);
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      service_name: "groq",
      model: "openai/gpt-oss-20b",
      temperature: 0.2,
      max_tokens: 1024,
      messages,
    });
    // No body-level tenant/user override — the API key establishes identity (SPEC §14).
    expect(body).not.toHaveProperty("tenant_id");
    expect(body).not.toHaveProperty("user_id");
    // No streaming, ever (SPEC §2.2).
    expect(body).not.toHaveProperty("stream");
  });

  it("omits tools/tool_choice when there are none, includes them when there are", async () => {
    const fetchImpl = vi.fn(async () => completion(baseCompletion)) as unknown as typeof fetch;
    const client = makeClient(fetchImpl);

    await client.chat({ model: "m", messages });
    let body = JSON.parse((fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]![1].body as string);
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("tool_choice");

    await client.chat({
      model: "m",
      messages,
      tools: [
        { type: "function", function: { name: "t", description: "d", parameters: { type: "object" } } },
      ],
      toolChoice: "auto",
    });
    body = JSON.parse((fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[1]![1].body as string);
    expect(body.tool_choice).toBe("auto");
    expect(body.tools).toHaveLength(1);
  });

  it("passes session_id only when set", async () => {
    const fetchImpl = vi.fn(async () => completion(baseCompletion)) as unknown as typeof fetch;
    const client = makeClient(fetchImpl);
    await client.chat({ model: "m", messages, sessionId: "s-1" });
    const body = JSON.parse((fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]![1].body as string);
    expect(body.session_id).toBe("s-1");
  });

  it("parses content, tool_calls, usage, cache_info and reads the EFFECTIVE model back", async () => {
    const fetchImpl = vi.fn(async () =>
      completion(
        {
          // Fallback switched the model — we must report the effective one.
          model: "openai/gpt-oss-safeguard-20b",
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                reasoning_content: "thinking...", // gateway-only field: dropped
                tool_calls: [
                  { id: "call_1", type: "function", function: { name: "gateway_health", arguments: "{}" } },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 30, completion_tokens: 15, total_tokens: 45 },
          cache_info: { source: "llm", cache_hit: false, exact_hash: "abc" },
        },
        { "X-Cache": "MISS" },
      )) as unknown as typeof fetch;

    const resp = await makeClient(fetchImpl).chat({
      model: "openai/gpt-oss-20b",
      messages,
      tools: [{ type: "function", function: { name: "gateway_health", description: "d", parameters: { type: "object" } } }],
    });

    expect(resp.requestedModel).toBe("openai/gpt-oss-20b");
    expect(resp.model).toBe("openai/gpt-oss-safeguard-20b");
    expect(resp.finishReason).toBe("tool_calls");
    expect(resp.message.tool_calls).toEqual([
      { id: "call_1", type: "function", function: { name: "gateway_health", arguments: "{}" } },
    ]);
    expect(resp.message.content).toBeNull();
    expect(resp.usage.total_tokens).toBe(45);
    expect(resp.cacheInfo).toMatchObject({ source: "llm" });
    expect(resp.xCache).toBe("MISS");
    expect(resp.requestId).toMatch(/^af-/);
    expect(resp.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("maps 401 to a fatal GatewayError (SPEC §11)", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ detail: "Invalid or inactive API Key." }), { status: 401 })) as unknown as typeof fetch;
    const err = await makeClient(fetchImpl)
      .chat({ model: "m", messages })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GatewayError);
    expect((err as GatewayError).kind).toBe("auth");
    expect((err as GatewayError).fatal).toBe(true);
  });

  it("maps 429 with Retry-After to retryable quota (SPEC §11)", async () => {
    const fetchImpl = (async () =>
      new Response("rate limited", { status: 429, headers: { "Retry-After": "3" } })) as unknown as typeof fetch;
    const err = (await makeClient(fetchImpl).chat({ model: "m", messages }).catch((e: unknown) => e)) as GatewayError;
    expect(err.kind).toBe("quota");
    expect(err.retryAfterMs).toBe(3000);
    expect(err.fatal).toBe(false);
  });

  it("throws a GatewayError when the response has no choices", async () => {
    const fetchImpl = (async () => completion({ model: "m", choices: [] })) as unknown as typeof fetch;
    const err = await makeClient(fetchImpl)
      .chat({ model: "m", messages })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GatewayError);
    expect((err as Error).message).toMatch(/no choices/);
  });

  it("normalizes a missing usage block to zeros", async () => {
    const fetchImpl = (async () => completion({ model: "m", choices: baseCompletion.choices })) as unknown as typeof fetch;
    const resp = await makeClient(fetchImpl).chat({ model: "m", messages });
    expect(resp.usage).toEqual({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
  });
});
