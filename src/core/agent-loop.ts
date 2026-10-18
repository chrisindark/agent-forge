/**
 * The tool-calling agent loop (SPEC §7).
 *
 *   messages = [system, user]
 *   repeat up to MAX_STEPS:
 *     resp = chat({ messages, tools, tool_choice: "auto" })
 *     push assistant message (preserving tool_calls)
 *     if no tool_calls: return content
 *     for each tool_call: execute, push { role: "tool", tool_call_id, json }
 *
 * Stop conditions: no tool calls, MAX_STEPS, token budget, abort signal.
 * Tool errors are returned as tool content so the model can self-correct.
 */
import type { LlmLike } from "./llm-client.js";
import type { ToolExecutor } from "./tools/executor.js";
import type { ToolRegistry } from "./tools/registry.js";
import type {
  AgentResult,
  Message,
  RunEvent,
  TokenUsage,
} from "./types.js";
import { addUsage, emptyUsage } from "./types.js";

export interface AgentLoopOptions {
  llm: LlmLike;
  registry: ToolRegistry;
  executor: ToolExecutor;
  systemPrompt: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  /** Hard stop on loop iterations (default 8). */
  maxSteps?: number;
  /** Hard stop on cumulative tokens across the run (default 50 000). */
  budgetTokens?: number;
  sessionId?: string;
  /** Cancels the run between steps and during tool/LLM calls. */
  signal?: AbortSignal;
  onEvent?: (event: RunEvent) => void;
  runId?: string;
}

export async function runAgent(
  userMessage: string,
  opts: AgentLoopOptions,
): Promise<AgentResult> {
  const maxSteps = opts.maxSteps ?? 8;
  const budgetTokens = opts.budgetTokens ?? 50_000;
  const runId = opts.runId ?? `run-${Date.now()}`;
  const emit = opts.onEvent ?? ((): void => {});

  const messages: Message[] = [
    { role: "system", content: opts.systemPrompt },
    { role: "user", content: userMessage },
  ];
  let usage = emptyUsage();
  let steps = 0;

  emit({
    type: "run_started",
    runId,
    agent: opts.systemPrompt.slice(0, 60),
    startedAt: new Date().toISOString(),
  });

  try {
    for (steps = 1; steps <= maxSteps; steps++) {
      if (opts.signal?.aborted) return fail(usage, steps - 1, "Run aborted before LLM call");

      const resp = await opts.llm.chat(
        {
          model: opts.model,
          messages,
          tools: opts.registry.toOpenAI(),
          toolChoice: "auto",
          temperature: opts.temperature,
          maxTokens: opts.maxTokens,
          sessionId: opts.sessionId,
        },
        opts.signal,
      );
      usage = addUsage(usage, resp.usage);
      emit({
        type: "llm_call",
        step: steps,
        model: resp.model,
        latencyMs: resp.latencyMs,
        usage: resp.usage,
        cacheInfo: resp.cacheInfo,
        requestId: resp.requestId,
      });

      // Preserve tool_calls when pushing the assistant message back (SPEC §7).
      messages.push(resp.message);

      const toolCalls = resp.message.tool_calls ?? [];
      if (toolCalls.length === 0) {
        const result: AgentResult = {
          ok: true,
          content: resp.message.content,
          steps,
          usage,
        };
        emit({
          type: "run_finished",
          runId,
          ok: true,
          steps,
          usage,
        });
        return result;
      }

      for (const tc of toolCalls) {
        if (opts.signal?.aborted) {
          return fail(usage, steps, "Run aborted during tool execution");
        }
        const outcome = await opts.executor.run(tc, {
          runId,
          signal: opts.signal,
        });
        messages.push(opts.executor.toToolMessage(outcome));
        emit({
          type: "tool_call",
          step: steps,
          name: outcome.name,
          ok: outcome.ok,
          durationMs: outcome.durationMs,
          error: outcome.error ? `${outcome.error.code}: ${outcome.error.message}` : undefined,
        });
      }

      if (usage.total_tokens > budgetTokens) {
        return fail(
          usage,
          steps,
          `Token budget exceeded after step ${steps}: ${usage.total_tokens} > ${budgetTokens}`,
        );
      }
    }

    return fail(usage, maxSteps, `MAX_STEPS (${maxSteps}) exceeded without a final answer`);
  } catch (err) {
    return fail(usage, steps, err instanceof Error ? err.message : String(err));
  }

  function fail(runUsage: TokenUsage, doneSteps: number, error: string): AgentResult {
    emit({
      type: "run_finished",
      runId,
      ok: false,
      steps: doneSteps,
      usage: runUsage,
      error,
    });
    return { ok: false, content: null, steps: doneSteps, usage: runUsage, error };
  }
}
