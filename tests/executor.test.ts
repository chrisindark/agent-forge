import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ToolRegistry } from "../src/core/tools/registry.js";
import { ToolExecutor } from "../src/core/tools/executor.js";
import type { ToolCall, ToolDef } from "../src/core/types.js";

const ctx = { runId: "test-run" };

function call(name: string, args: unknown): ToolCall {
  return {
    id: `call_${name}`,
    type: "function",
    function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) },
  };
}

function addTool(overrides: Partial<ToolDef<{ a: number; b: number }>> = {}) {
  return {
    name: "add",
    description: "Add two numbers",
    schema: z.object({ a: z.number(), b: z.number() }),
    handler: async ({ a, b }: { a: number; b: number }) => ({ sum: a + b }),
    ...overrides,
  } satisfies ToolDef<{ a: number; b: number }>;
}

describe("ToolExecutor", () => {
  it("runs a valid tool call and returns the result", async () => {
    const executor = new ToolExecutor(new ToolRegistry().register(addTool()));
    const outcome = await executor.run(call("add", { a: 2, b: 3 }), ctx);
    expect(outcome.ok).toBe(true);
    expect(outcome.result).toEqual({ sum: 5 });
    expect(outcome.toolCallId).toBe("call_add");
    expect(outcome.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("returns the tool message with ok:true and JSON content", async () => {
    const executor = new ToolExecutor(new ToolRegistry().register(addTool()));
    const outcome = await executor.run(call("add", { a: 1, b: 1 }), ctx);
    const msg = executor.toToolMessage(outcome);
    expect(msg.role).toBe("tool");
    expect(msg.tool_call_id).toBe("call_add");
    expect(JSON.parse(msg.content!)).toEqual({ ok: true, result: { sum: 2 } });
  });

  it("captures unknown tools without throwing", async () => {
    const executor = new ToolExecutor(new ToolRegistry());
    const outcome = await executor.run(call("nope", {}), ctx);
    expect(outcome.ok).toBe(false);
    expect(outcome.error?.code).toBe("unknown_tool");
  });

  it("captures malformed JSON arguments", async () => {
    const executor = new ToolExecutor(new ToolRegistry().register(addTool()));
    const outcome = await executor.run(call("add", "{not json"), ctx);
    expect(outcome.ok).toBe(false);
    expect(outcome.error?.code).toBe("invalid_json");
  });

  it("validates arguments with zod and reports field-level errors", async () => {
    const executor = new ToolExecutor(new ToolRegistry().register(addTool()));
    const outcome = await executor.run(call("add", { a: "two", b: 3 }), ctx);
    expect(outcome.ok).toBe(false);
    expect(outcome.error?.code).toBe("invalid_arguments");
    expect(outcome.error?.message).toMatch(/a:/);
  });

  it("captures handler exceptions as {ok:false,error}", async () => {
    const executor = new ToolExecutor(
      new ToolRegistry().register(
        addTool({ handler: async () => { throw new Error("boom"); } }),
      ),
    );
    const outcome = await executor.run(call("add", { a: 1, b: 2 }), ctx);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toEqual({ code: "tool_error", message: "boom" });
    const msg = executor.toToolMessage(outcome);
    expect(JSON.parse(msg.content!)).toEqual({
      ok: false,
      error: { code: "tool_error", message: "boom" },
    });
  });

  it("enforces the per-tool timeout", async () => {
    const executor = new ToolExecutor(
      new ToolRegistry().register(
        addTool({
          timeoutMs: 25,
          handler: () => new Promise((resolve) => setTimeout(() => resolve({ sum: 0 }), 200)),
        }),
      ),
    );
    const outcome = await executor.run(call("add", { a: 1, b: 1 }), ctx);
    expect(outcome.ok).toBe(false);
    expect(outcome.error?.code).toBe("timeout");
    expect(outcome.error?.message).toMatch(/25ms/);
  }, 1_000);

  it("uses the executor default timeout when the tool has none", async () => {
    const registry = new ToolRegistry().register(
      addTool({ handler: () => new Promise((resolve) => setTimeout(() => resolve({ sum: 0 }), 60)) }),
    );
    const executor = new ToolExecutor(registry, 10);
    const outcome = await executor.run(call("add", { a: 1, b: 1 }), ctx);
    expect(outcome.error?.code).toBe("timeout");
  }, 1_000);
});
