/**
 * Tool executor (SPEC §8): JSON-parse + zod-validate arguments, enforce a
 * per-tool timeout, and capture thrown errors as structured results so the
 * model can self-correct instead of aborting the run (SPEC §7).
 */
import type { Message, ToolCall, ToolContext } from "../types.js";
import type { ToolRegistry } from "./registry.js";

export type ToolErrorCode =
  | "unknown_tool"
  | "invalid_json"
  | "invalid_arguments"
  | "timeout"
  | "aborted"
  | "tool_error";

export interface ToolOutcome {
  toolCallId: string;
  name: string;
  ok: boolean;
  result?: unknown;
  error?: { code: ToolErrorCode; message: string };
  durationMs: number;
}

export class ToolExecutor {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly defaultTimeoutMs: number = 10_000,
  ) {}

  /**
   * Execute one tool call. Never throws — every failure mode (unknown tool,
   * malformed args, validation error, timeout, handler crash) is returned as
   * a structured `ToolOutcome`.
   */
  async run(call: ToolCall, ctx: ToolContext): Promise<ToolOutcome> {
    const startedAt = Date.now();
    const finish = (partial: Omit<ToolOutcome, "toolCallId" | "name" | "durationMs">): ToolOutcome => ({
      toolCallId: call.id,
      name: call.function.name,
      durationMs: Date.now() - startedAt,
      ...partial,
    });

    const tool = this.registry.get(call.function.name);
    if (!tool) {
      return finish({
        ok: false,
        error: { code: "unknown_tool", message: `Unknown tool: ${call.function.name}` },
      });
    }

    let args: unknown;
    try {
      args = JSON.parse(call.function.arguments || "{}");
    } catch (err) {
      return finish({
        ok: false,
        error: {
          code: "invalid_json",
          message: `Arguments for "${tool.name}" are not valid JSON: ${(err as Error).message}`,
        },
      });
    }

    const parsed = tool.schema.safeParse(args);
    if (!parsed.success) {
      return finish({
        ok: false,
        error: {
          code: "invalid_arguments",
          message: `Invalid arguments for "${tool.name}": ${parsed.error.issues
            .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
            .join("; ")}`,
        },
      });
    }

    const timeoutMs = tool.timeoutMs ?? this.defaultTimeoutMs;
    try {
      const result = await withTimeout(
        tool.handler(parsed.data as never, { ...ctx, signal: mergeSignals(ctx.signal) }),
        timeoutMs,
        ctx.signal,
      );
      return finish({ ok: true, result });
    } catch (err) {
      return finish({ ok: false, error: classifyThrown(err, timeoutMs) });
    }
  }

  /** Tool message for the transcript, per SPEC §7: `{ok:true,result}` / `{ok:false,error}`. */
  toToolMessage(outcome: ToolOutcome): Message {
    const payload = outcome.ok
      ? { ok: true, result: outcome.result ?? null }
      : { ok: false, error: outcome.error };
    return {
      role: "tool",
      tool_call_id: outcome.toolCallId,
      content: JSON.stringify(payload),
    };
  }
}

function classifyThrown(
  err: unknown,
  timeoutMs: number,
): { code: ToolErrorCode; message: string } {
  if (err instanceof ToolTimeoutError) {
    return { code: "timeout", message: `Tool timed out after ${timeoutMs}ms` };
  }
  if (err instanceof Error && err.name === "AbortError") {
    return { code: "aborted", message: "Tool execution was aborted" };
  }
  return {
    code: "tool_error",
    message: err instanceof Error ? err.message : String(err),
  };
}

export class ToolTimeoutError extends Error {
  constructor(ms: number) {
    super(`Tool execution exceeded ${ms}ms`);
    this.name = "ToolTimeoutError";
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ToolTimeoutError(timeoutMs)), timeoutMs);
  });

  const abort = new Promise<never>((_, reject) => {
    if (!signal) return;
    onAbort = () => reject(new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
  });

  try {
    return await Promise.race([promise, timeout, abort]);
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  }
}

/** Placeholder for run-level cancellation wiring (M3/M5). */
function mergeSignals(signal?: AbortSignal): AbortSignal | undefined {
  return signal;
}
