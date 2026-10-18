/**
 * M0 smoke test: (1) `gateway_health` through the real registry + executor,
 * (2) a single-turn chat completion against the gateway.
 *
 *   npm run smoke
 *
 * Fails fast with a readable message when the gateway is not running.
 * The full LLM client lands in M1 — the single-turn call here is intentionally
 * minimal.
 */
import "dotenv/config";
import { loadConfig } from "./core/config.js";
import { GatewayClient } from "./core/gateway/gateway-client.js";
import { ToolExecutor } from "./core/tools/executor.js";
import { ToolRegistry } from "./core/tools/registry.js";
import { createGatewayHealthTool } from "./tools/gateway/health.js";
import { GatewayError } from "./core/errors.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const client = new GatewayClient({
    baseUrl: config.GATEWAY_URL,
    apiKey: config.GATEWAY_API_KEY,
    timeoutMs: 60_000,
  });

  console.log(`→ gateway: ${config.GATEWAY_URL}`);
  console.log(`→ model:   ${config.AGENT_PROVIDER}/${config.AGENT_MODEL}`);

  // 1. Health tool round trip through registry + executor.
  const registry = new ToolRegistry().register(createGatewayHealthTool(client));
  const executor = new ToolExecutor(registry, config.TOOL_TIMEOUT_MS);
  const outcome = await executor.run(
    { id: "smoke-health-1", type: "function", function: { name: "gateway_health", arguments: "{}" } },
    { runId: "smoke-m0" },
  );

  if (!outcome.ok) {
    throw new Error(`gateway_health failed: ${JSON.stringify(outcome.error)}`);
  }
  const health = outcome.result as { healthy: boolean; degraded: string[] };
  console.log(
    health.healthy
      ? "✓ gateway_health: all subsystems ok"
      : `✗ gateway_health: degraded → ${health.degraded.join(", ")}`,
  );

  // 2. Single-turn chat completion (no tools).
  const startedAt = Date.now();
  let res: Response;
  try {
    res = await fetch(`${config.GATEWAY_URL}/api/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": config.GATEWAY_API_KEY,
        "X-Request-ID": "smoke-m0-single-turn",
      },
      body: JSON.stringify({
        service_name: config.AGENT_PROVIDER,
        model: config.AGENT_MODEL,
        messages: [{ role: "user", content: "Reply with exactly: pong" }],
        temperature: config.TEMPERATURE,
        max_tokens: config.MAX_TOKENS,
      }),
      signal: AbortSignal.timeout(90_000),
    });
  } catch (err) {
    throw new GatewayError({
      message: `Gateway unreachable: ${(err as Error).message}`,
      status: 0,
      kind: "network",
      cause: err,
    });
  }

  if (!res.ok) {
    throw new GatewayError({
      message: `Single-turn completion returned ${res.status}`,
      status: res.status,
      detail: await res.text().catch(() => undefined),
    });
  }

  const body = (await res.json()) as {
    model?: string;
    choices?: { message?: { content?: string } }[];
    usage?: { total_tokens?: number };
  };
  const content = body.choices?.[0]?.message?.content ?? "(no content)";
  console.log(`✓ single-turn in ${Date.now() - startedAt}ms (effective model: ${body.model ?? "?"})`);
  console.log(`  ${content}`);
  console.log("\nM0 smoke test passed.");
}

main().catch((err: unknown) => {
  console.error("\nM0 smoke test FAILED");
  if (err instanceof GatewayError) {
    console.error(`  ${err.message}`);
    if (err.status === 0) {
      console.error(`  → Is Echo Gate running at ${process.env.GATEWAY_URL ?? "http://localhost:8000"}?`);
    }
    if (err.detail) console.error(`  detail: ${String(err.detail).slice(0, 500)}`);
  } else if (err instanceof Error) {
    console.error(`  ${err.message}`);
  } else {
    console.error(String(err));
  }
  process.exitCode = 1;
});
