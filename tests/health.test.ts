import { describe, expect, it, vi } from "vitest";
import { GatewayClient } from "../src/core/gateway/gateway-client.js";
import { GatewayError } from "../src/core/errors.js";
import { ToolRegistry } from "../src/core/tools/registry.js";
import { ToolExecutor } from "../src/core/tools/executor.js";
import { createGatewayHealthTool } from "../src/tools/gateway/health.js";

function jsonResponse(status: number, body: unknown = { status: "ok" }): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockFetch(routes: Record<string, Response>): typeof fetch {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    const match = Object.entries(routes).find(([path]) => url.endsWith(path));
    if (!match) return new Response("not found", { status: 404 });
    return match[1].clone();
  }) as unknown as typeof fetch;
}

describe("GatewayClient", () => {
  it("sends X-API-Key and resolves relative to baseUrl", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { hello: "world" })) as unknown as typeof fetch;
    const client = new GatewayClient({
      baseUrl: "http://localhost:8000/",
      apiKey: "eg_secret",
      fetchImpl,
    });
    const body = await client.get<{ hello: string }>("/api/v1/gateway-requests/");
    expect(body).toEqual({ hello: "world" });
    const [url, init] = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
    expect(url).toBe("http://localhost:8000/api/v1/gateway-requests/");
    expect((init as RequestInit).headers).toMatchObject({ "X-API-Key": "eg_secret" });
  });

  it("maps error statuses to GatewayError with Retry-After", async () => {
    const fetchImpl = mockFetch({});
    const client = new GatewayClient({ baseUrl: "http://x", apiKey: "k", fetchImpl });
    // 404 route miss from mockFetch
    await expect(client.get("/nothing")).rejects.toMatchObject({
      name: "GatewayError",
      status: 404,
      kind: "unknown",
    });
  });

  it("classifies 429 as retryable quota with Retry-After (SPEC §11)", async () => {
    const fetchImpl = (async () =>
      new Response("slow down", { status: 429, headers: { "Retry-After": "2" } })) as unknown as typeof fetch;
    const client = new GatewayClient({ baseUrl: "http://x", apiKey: "k", fetchImpl });
    const err = await client.get("/api/v1/x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GatewayError);
    expect((err as GatewayError).kind).toBe("quota");
    expect((err as GatewayError).retryAfterMs).toBe(2_000);
    expect((err as GatewayError).fatal).toBe(false);
  });

  it("marks 401/402/400 as fatal", async () => {
    for (const [status, kind] of [
      [401, "auth"],
      [402, "budget"],
      [400, "validation"],
    ] as const) {
      const fetchImpl = (async () => new Response("x", { status })) as unknown as typeof fetch;
      const client = new GatewayClient({ baseUrl: "http://x", apiKey: "k", fetchImpl });
      const err = (await client.get("/p").catch((e: unknown) => e)) as GatewayError;
      expect(err.kind).toBe(kind);
      expect(err.fatal).toBe(true);
    }
  });
});

describe("gateway_health tool", () => {
  it("reports all subsystems healthy", async () => {
    const fetchImpl = mockFetch({
      "/api/v1/health/ready": jsonResponse(200),
      "/api/v1/health/worker": jsonResponse(200),
      "/api/v1/health/celery": jsonResponse(200),
    });
    const client = new GatewayClient({ baseUrl: "http://gw", apiKey: "k", fetchImpl });
    const registry = new ToolRegistry().register(createGatewayHealthTool(client));
    const outcome = await new ToolExecutor(registry).run(
      { id: "c1", type: "function", function: { name: "gateway_health", arguments: "{}" } },
      { runId: "t" },
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.result).toMatchObject({ healthy: true, degraded: [] });
  });

  it("names degraded subsystems", async () => {
    const fetchImpl = mockFetch({
      "/api/v1/health/ready": jsonResponse(200),
      "/api/v1/health/worker": new Response("down", { status: 503 }),
      "/api/v1/health/celery": new Response("no broker", { status: 503 }),
    });
    const client = new GatewayClient({ baseUrl: "http://gw", apiKey: "k", fetchImpl });
    const registry = new ToolRegistry().register(createGatewayHealthTool(client));
    const outcome = await new ToolExecutor(registry).run(
      { id: "c1", type: "function", function: { name: "gateway_health", arguments: "{}" } },
      { runId: "t" },
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.result).toMatchObject({
      healthy: false,
      degraded: ["worker", "celery"],
      worker: { ok: false, status: 503 },
    });
  });

  it("degrades gracefully when the gateway is unreachable", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const client = new GatewayClient({ baseUrl: "http://gw", apiKey: "k", fetchImpl });
    const registry = new ToolRegistry().register(createGatewayHealthTool(client));
    const outcome = await new ToolExecutor(registry).run(
      { id: "c1", type: "function", function: { name: "gateway_health", arguments: "{}" } },
      { runId: "t" },
    );
    // The health tool reports degraded rather than exploding the run.
    expect(outcome.ok).toBe(true);
    expect(outcome.result).toMatchObject({
      healthy: false,
      degraded: ["ready", "worker", "celery"],
    });
  });
});
