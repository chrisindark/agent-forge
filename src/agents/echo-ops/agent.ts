/**
 * Echo Ops agent definition — system prompt + tool set + runtime wiring.
 *
 * Composes the provider-agnostic runtime (LlmClient + runAgent) with the
 * gateway adapter. Adding another agent should only mean a prompt + tool list.
 */
import type { AppConfig } from "../../core/config.js";
import { runAgent } from "../../core/agent-loop.js";
import { GatewayClient } from "../../core/gateway/gateway-client.js";
import { LlmClient } from "../../core/llm-client.js";
import { ToolExecutor } from "../../core/tools/executor.js";
import { ToolRegistry } from "../../core/tools/registry.js";
import type { AgentResult, RunEvent } from "../../core/types.js";
import { ECHO_OPS_SYSTEM_PROMPT } from "./prompt.js";
import { createEchoOpsTools } from "./tools.js";

export interface CreateEchoOpsOptions {
  config: AppConfig;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

export interface EchoOpsAgent {
  systemPrompt: string;
  registry: ToolRegistry;
  run(
    message: string,
    opts?: { signal?: AbortSignal; onEvent?: (event: RunEvent) => void },
  ): Promise<AgentResult>;
}

export function createEchoOpsAgent(opts: CreateEchoOpsOptions): EchoOpsAgent {
  const { config } = opts;

  const gateway = new GatewayClient({
    baseUrl: config.GATEWAY_URL,
    apiKey: config.GATEWAY_API_KEY,
    fetchImpl: opts.fetchImpl,
  });

  const registry = new ToolRegistry();
  for (const tool of createEchoOpsTools(gateway)) registry.register(tool);
  const executor = new ToolExecutor(registry, config.TOOL_TIMEOUT_MS);

  // Echo Gate niceties stay in the wiring, not the runtime (SPEC §5).
  const llm = new LlmClient({
    baseUrl: config.GATEWAY_URL,
    apiKey: config.GATEWAY_API_KEY,
    extraBody: { service_name: config.AGENT_PROVIDER },
    fetchImpl: opts.fetchImpl,
  });

  return {
    systemPrompt: ECHO_OPS_SYSTEM_PROMPT,
    registry,
    run: (message, runOpts) =>
      runAgent(message, {
        llm,
        registry,
        executor,
        systemPrompt: ECHO_OPS_SYSTEM_PROMPT,
        model: config.AGENT_MODEL,
        temperature: config.TEMPERATURE,
        maxTokens: config.MAX_TOKENS,
        maxSteps: config.MAX_STEPS,
        budgetTokens: config.RUN_BUDGET_TOKENS,
        sessionId: config.AGENT_SESSION_ID || undefined,
        signal: runOpts?.signal,
        onEvent: runOpts?.onEvent,
      }),
  };
}
