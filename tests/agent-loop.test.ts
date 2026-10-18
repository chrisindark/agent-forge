import { describe, expect, it } from "vitest";
import { z } from "zod";
import { runAgent } from "../src/core/agent-loop.js";
import type { ChatRequest, ChatResponse, LlmLike } from "../src/core/llm-client.js";
import { ToolExecutor } from "../src/core/tools/executor.js";
import { ToolRegistry } from "../src/core/tools/registry.js";
import type { RunEvent, TokenUsage } from "../src/core/types.js";

/** Scripted fake model: pops the next canned response, records every request. */
class FakeLlm implements LlmLike {
  readonly requests: ChatRequest[] = [];
  private cursor = 0;

  constructor(private readonly script: ChatResponse[]) {}

  async chat(req: ChatRequest): Promise<ChatResponse> {
    this.requests.push(structuredClone(req));
    const resp = this.script[this.cursor++];
    if (!resp) throw new Error(`FakeLlm exhausted at call ${this.cursor}`);
    return resp;
  }
}

function usage(total: number): TokenUsage {
  return { prompt_tokens: total - 1, completion_tokens: 1, total_tokens: total };
}

function resp(partial: Partial<ChatResponse> & { message: ChatResponse["message"] }): ChatResponse {
  return {
    finishReason: "stop",
    usage: usage(10),
    model: "openai/gpt-oss-20b",
    requestedModel: "openai/gpt-oss-20b",
    xCache: null,
    requestId: `af-test-${Math.random().toString(36).slice(2)}`,
    latencyMs: 5,
    ...partial,
  };
}

function toolCallResp(name: string, args: object, id = "call_1"): ChatResponse {
  return resp({
    message: {
      role: "assistant",
      content: null,
      tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
    },
    finishReason: "tool_calls",
  });
}

function finalResp(content: string): ChatResponse {
  return resp({ message: { role: "assistant", content } });
}

function echoRegistry(): { registry: ToolRegistry; executor: ToolExecutor } {
  const registry = new ToolRegistry().register({
    name: "echo",
    description: "Echo the input back",
    schema: z.object({ text: z.string() }),
    handler: async ({ text }) => ({ echoed: text }),
  });
  return { registry, executor: new ToolExecutor(registry, 1000) };
}

function baseOpts(llm: FakeLlm, over: Partial<Parameters<typeof runAgent>[1]> = {}) {
  const { registry, executor } = echoRegistry();
  return {
    llm,
    registry,
    executor,
    systemPrompt: "You are a test agent.",
    model: "openai/gpt-oss-20b",
    ...over,
  };
}

describe("runAgent", () => {
  it("returns the final answer when the model calls no tools", async () => {
    const llm = new FakeLlm([finalResp("hello there")]);
    const result = await runAgent("hi", baseOpts(llm));
    expect(result).toMatchObject({ ok: true, content: "hello there", steps: 1 });
    expect(result.usage.total_tokens).toBe(10);
    // Transcript: system + user only (no assistant echo needed).
    expect(llm.requests[0]!.messages.map((m) => m.role)).toEqual(["system", "user"]);
  });

  it("executes a tool round trip and preserves tool_calls + tool_call_id", async () => {
    const llm = new FakeLlm([
      toolCallResp("echo", { text: "ping" }),
      finalResp("the tool said ping"),
    ]);
    const events: RunEvent[] = [];
    const result = await runAgent("echo ping", baseOpts(llm, { onEvent: (e) => events.push(e) }));

    expect(result.ok).toBe(true);
    expect(result.content).toBe("the tool said ping");
    expect(result.steps).toBe(2);
    expect(result.usage.total_tokens).toBe(20);

    // Second request must contain the assistant message WITH tool_calls and the tool result.
    const second = llm.requests[1]!;
    expect(second.messages.map((m) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
      "tool",
    ]);
    const assistant = second.messages[2]!;
    expect(assistant.tool_calls?.[0]?.function.name).toBe("echo");
    const toolMsg = second.messages[3]!;
    expect(toolMsg.tool_call_id).toBe("call_1");
    expect(JSON.parse(toolMsg.content!)).toEqual({ ok: true, result: { echoed: "ping" } });

    // Event stream: started, llm x2, tool, finished.
    expect(events.map((e) => e.type)).toEqual([
      "run_started",
      "llm_call",
      "tool_call",
      "llm_call",
      "run_finished",
    ]);
    expect(events.find((e) => e.type === "tool_call")).toMatchObject({
      name: "echo",
      ok: true,
    });
  });

  it("feeds tool failures back so the model can self-correct (SPEC §7)", async () => {
    const { registry, executor } = echoRegistry();
    const llm = new FakeLlm([
      toolCallResp("does_not_exist", {}),
      finalResp("that tool does not exist"),
    ]);
    const result = await runAgent("go", baseOpts(llm, { registry, executor }));

    expect(result.ok).toBe(true);
    const toolMsg = llm.requests[1]!.messages[3]!;
    expect(JSON.parse(toolMsg.content!)).toMatchObject({
      ok: false,
      error: { code: "unknown_tool" },
    });
  });

  it("stops with an error when MAX_STEPS is exceeded", async () => {
    const llm = new FakeLlm([
      toolCallResp("echo", { text: "a" }),
      toolCallResp("echo", { text: "b" }),
      toolCallResp("echo", { text: "c" }),
    ]);
    const result = await runAgent("loop", baseOpts(llm, { maxSteps: 3 }));

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/MAX_STEPS \(3\) exceeded/);
    expect(result.steps).toBe(3);
    expect(llm.requests).toHaveLength(3);
  });

  it("stops when the token budget is exhausted", async () => {
    const llm = new FakeLlm([
      resp({ message: { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "echo", arguments: '{"text":"x"}' } }] }, finishReason: "tool_calls", usage: usage(60) }),
      resp({ message: { role: "assistant", content: null, tool_calls: [{ id: "c2", type: "function", function: { name: "echo", arguments: '{"text":"y"}' } }] }, finishReason: "tool_calls", usage: usage(60) }),
    ]);
    const result = await runAgent("spend", baseOpts(llm, { budgetTokens: 100 }));

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Token budget exceeded/);
    expect(result.usage.total_tokens).toBe(120);
    expect(llm.requests).toHaveLength(2);
  });

  it("stops on abort signal without calling the model", async () => {
    const controller = new AbortController();
    controller.abort();
    const llm = new FakeLlm([finalResp("never")]);
    const result = await runAgent("cancelled", baseOpts(llm, { signal: controller.signal }));

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/aborted/);
    expect(llm.requests).toHaveLength(0);
  });

  it("captures LLM failures as a failed result instead of throwing", async () => {
    const failing: LlmLike = {
      chat: async () => {
        throw new Error("gateway exploded");
      },
    };
    const { registry, executor } = echoRegistry();
    const result = await runAgent("x", { llm: failing, registry, executor, systemPrompt: "s", model: "m" });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("gateway exploded");
  });

  it("sends tools + tool_choice: auto on every model call", async () => {
    const llm = new FakeLlm([finalResp("done")]);
    await runAgent("hi", baseOpts(llm));
    expect(llm.requests[0]!.toolChoice).toBe("auto");
    expect(llm.requests[0]!.tools?.[0]?.function.name).toBe("echo");
  });
});
