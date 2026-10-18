/**
 * M0 smoke test (hermetic): single-turn completion + health tool round trip
 * against a mocked gateway. The live version is `npm run smoke`.
 */
import { describe, expect, it, vi } from "vitest";
import { GatewayClient } from "../src/core/gateway/gateway-client.js";
import { ToolExecutor } from "../src/core/tools/executor.js";
import { ToolRegistry } from "../src/core/tools/registry.js";
import { createGatewayHealthTool } from "../src/tools/gateway/health.js";
import { loadConfig } from "../src/core/config.js";

const gateway = {
  "/api/v1/health/ready": new Response(JSON.stringify({ status: "ok" }), { status: 200 }),
  "/api/v1/health/worker": new Response(JSON.stringify({ status: "ok" }), { status: 200 }),
  "/api/v1/health/celery": new Response(JSON.stringify({ status: "ok" }), { status: 200 }),
  "/api/v1/chat/completions": new Response(
    JSON.stringify({
      model: "openai/gpt-oss-20b",
      choices: [
        {
          message: { role: "assistant", content: "pong" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
      cache_info: { source: "llm", cache_hit: false },
    }),
    { status: 200, headers: { "X-Cache": "MISS" } },
  ),
};

function mockFetch(): typeof fetch {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    const match = Object.entries(gateway).find(([path]) => url.endsWith(path));
    if (!match) return new Response("not found", { status: 404 });
    return match[1].clone();
  }) as unknown as typeof fetch;
}

describe("M0 smoke (hermetic)", () => {
  it("loads config with SPEC §10 defaults", () => {
    const cfg = loadConfig({ GATEWAY_API_KEY: "eg_test" });
    expect(cfg.GATEWAY_URL).toBe("http://localhost:8000");
    expect(cfg.AGENT_MODEL).toBe("openai/gpt-oss-20b");
  });

  it("runs gateway_health through registry + executor", async () => {
    const client = new GatewayClient({ baseUrl: "http://localhost:8000", apiKey: "k", fetchImpl: mockFetch() });
    const registry = new ToolRegistry().register(createGatewayHealthTool(client));
    const outcome = await new ToolExecutor(registry).run(
      { id: "smoke-1", type: "function", function: { name: "gateway_health", arguments: "{}" } },
      { runId: "smoke-m0" },
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.result).toMatchObject({ healthy: true, degraded: [] });
  });

  it("completes a single-turn chat completion and reads the effective model back", async () => {
    const fetchImpl = mockFetch();
    const cfg = loadConfig({ GATEWAY_API_KEY: "eg_test" });
    const res = await fetchImpl(`${cfg.GATEWAY_URL}/api/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": cfg.GATEWAY_API_KEY },
      body: JSON.stringify({
        service_name: cfg.AGENT_PROVIDER,
        model: cfg.AGENT_MODEL,
        messages: [{ role: "user", content: "Reply with exactly: pong" }],
      }),
    });
    const body = (await res.json()) as {
      model: string;
      choices: { message: { content: string } }[];
      cache_info: { source: string };
    };
    // Read the effective model back — a fallback may have switched it (SPEC §6).
    expect(body.model).toBe("openai/gpt-oss-20b");
    expect(body.choices[0]!.message.content).toBe("pong");
    expect(body.cache_info.source).toBe("llm");
  });
});
