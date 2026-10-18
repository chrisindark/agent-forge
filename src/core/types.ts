/**
 * Core harness types — provider-agnostic (SPEC.md §5, §8).
 *
 * Gateway-specific fields (`cache_info`, `service_name`, ...) must NOT appear
 * here; they live in the gateway adapter layer.
 */
import type { z } from "zod";

export type Role = "system" | "user" | "assistant" | "tool";

/** A model-requested tool invocation, exactly as it came off the wire. */
export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    /** JSON-encoded arguments — parse + validate before executing (SPEC §7). */
    arguments: string;
  };
}

/**
 * Chat message. Invariants when echoing back to the gateway (SPEC §7):
 * - assistant messages MUST preserve `tool_calls`
 * - tool messages MUST carry `tool_call_id`
 */
export interface Message {
  role: Role;
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export type JSONSchema = Record<string, unknown>;

/** Ambient context handed to every tool invocation. */
export interface ToolContext {
  /** Aborted when the run is cancelled or a budget is exhausted. */
  signal?: AbortSignal;
  /**
   * Identifies this run, shared by every tool call it makes.
   *
   * Distinct from a per-call request ID: one run issues many gateway requests,
   * each with its own `requestId` on `RunEvent.llm_call`. A tool only knows the
   * run it belongs to, so it gets `runId`.
   */
  runId: string;
}

/**
 * A callable tool: a plain object with a name, description, schema, and async
 * handler (SPEC §8). Transport-agnostic so it can later be wrapped as MCP.
 */
export interface ToolDef<A = unknown> {
  name: string;
  description: string;
  /** zod schema — authoritative for argument validation. */
  schema: z.ZodType<A>;
  /**
   * OpenAI function `parameters`. Derived from `schema` when omitted;
   * set explicitly only when the model-facing schema must differ.
   */
  parameters?: JSONSchema;
  handler: (args: A, ctx: ToolContext) => Promise<unknown>;
  /** Per-tool override for TOOL_TIMEOUT_MS. */
  timeoutMs?: number;
  /** v2: mutating tools require an approval gate + mutation budget (SPEC §3.2). */
  mutating?: boolean;
}

/** Tool definition as sent to the LLM (`tools[]` entry). */
export interface OpenAIToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: JSONSchema;
  };
}

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

/** Final result of an agent run. */
export interface AgentResult {
  ok: boolean;
  content: string | null;
  steps: number;
  usage: TokenUsage;
  error?: string;
}

/** Structured events emitted by a run (consumed by the run tracer, M3). */
export type RunEvent =
  | { type: "run_started"; runId: string; agent: string; startedAt: string }
  | {
      type: "llm_call";
      step: number;
      model: string;
      latencyMs: number;
      usage: TokenUsage;
      cacheInfo?: unknown;
      requestId: string;
    }
  | {
      type: "tool_call";
      step: number;
      name: string;
      ok: boolean;
      durationMs: number;
      error?: string;
    }
  | {
      type: "run_finished";
      runId: string;
      ok: boolean;
      steps: number;
      usage: TokenUsage;
      error?: string;
    };

export function emptyUsage(): TokenUsage {
  return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    prompt_tokens: a.prompt_tokens + b.prompt_tokens,
    completion_tokens: a.completion_tokens + b.completion_tokens,
    total_tokens: a.total_tokens + b.total_tokens,
  };
}
