/**
 * OpenAI-compatible chat client for Echo Gate (SPEC §6).
 *
 * Provider-agnostic shape; Echo Gate-specific body fields (`service_name`,
 * `session_id`) are passed in as `extraBody`/options by the wiring layer.
 * Never streams — the gateway accepts `stream` but always returns one JSON
 * object (SPEC §2.2).
 */
import { randomUUID } from "node:crypto";
import { GatewayClient } from "./gateway/gateway-client.js";
import { GatewayError } from "./errors.js";
import type { Message, OpenAIToolDef, TokenUsage } from "./types.js";
import { emptyUsage } from "./types.js";

export interface LlmClientOptions {
  baseUrl: string;
  apiKey: string;
  /** Echo Gate body fields (e.g. `service_name: "groq"`); merged under request params. */
  extraBody?: Record<string, unknown>;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  /**
   * Per-call timeout. Tool-calling turns are full round trips and a tool turn
   * can chain provider calls — keep well above the gateway's own 15s provider
   * timeout (SPEC §2.2, §14).
   */
  timeoutMs?: number;
}

export type ToolChoice = "auto" | "required" | "none";

export interface ChatRequest {
  model: string;
  messages: Message[];
  tools?: OpenAIToolDef[];
  toolChoice?: ToolChoice;
  temperature?: number;
  maxTokens?: number;
  /** Binds a cache scope. */
  sessionId?: string;
}

export interface ChatResponse {
  /** Assistant message: `content` and/or `tool_calls`, exactly as sent back. */
  message: Message;
  finishReason: string | null;
  usage: TokenUsage;
  /** Effective model — a gateway fallback may have switched it (SPEC §6). */
  model: string;
  requestedModel: string;
  /** Echo Gate cache introspection, verbatim when present. */
  cacheInfo?: unknown;
  /** X-Cache response header. */
  xCache: string | null;
  /** X-Request-ID sent with the call — correlate with gateway traces (SPEC §12). */
  requestId: string;
  latencyMs: number;
}

/** What the agent loop needs — lets tests fake the model. */
export interface LlmLike {
  chat(req: ChatRequest, signal?: AbortSignal): Promise<ChatResponse>;
}

interface WireMessage {
  role: string;
  content: string | null;
  tool_calls?: {
    id: string;
    type?: string;
    function?: { name?: string; arguments?: string };
  }[] | null;
  tool_call_id?: string | null;
}

interface WireResponse {
  model?: string;
  choices?: {
    message?: WireMessage;
    finish_reason?: string | null;
  }[];
  usage?: Partial<TokenUsage> | null;
  cache_info?: unknown;
}

export class LlmClient implements LlmLike {
  private readonly gateway: GatewayClient;
  private readonly extraBody: Record<string, unknown>;
  private readonly defaultTimeoutMs: number;

  constructor(opts: LlmClientOptions) {
    this.gateway = new GatewayClient({
      baseUrl: opts.baseUrl,
      apiKey: opts.apiKey,
      fetchImpl: opts.fetchImpl,
      timeoutMs: opts.timeoutMs ?? 120_000,
    });
    this.extraBody = opts.extraBody ?? {};
    this.defaultTimeoutMs = opts.timeoutMs ?? 120_000;
  }

  async chat(req: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
    const requestId = `af-${randomUUID()}`;
    const startedAt = Date.now();

    const body = {
      ...this.extraBody,
      model: req.model,
      messages: req.messages,
      temperature: req.temperature,
      max_tokens: req.maxTokens,
      ...(req.tools && req.tools.length > 0
        ? { tools: req.tools, tool_choice: req.toolChoice ?? "auto" }
        : {}),
      ...(req.sessionId ? { session_id: req.sessionId } : {}),
    };

    let res: { data: WireResponse; headers: Headers };
    try {
      res = await this.gateway.requestDetailed<WireResponse>(
        "/api/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Request-ID": requestId,
          },
          body: JSON.stringify(body),
        },
        signal,
      );
    } catch (err) {
      // Network/HTTP failures: surface latency + request id for correlation.
      if (err instanceof GatewayError && err.status !== 0) throw err;
      throw new GatewayError({
        message: err instanceof GatewayError ? err.message : `LLM call failed: ${(err as Error).message}`,
        status: err instanceof GatewayError ? err.status : 0,
        kind: err instanceof GatewayError ? err.kind : "network",
        retryAfterMs: err instanceof GatewayError ? err.retryAfterMs : undefined,
        detail: err instanceof GatewayError ? err.detail : undefined,
        cause: err,
      });
    }

    const parsed = res.data;
    const choice = parsed.choices?.[0];
    if (!choice?.message) {
      throw new GatewayError({
        message: "LLM response contained no choices[0].message",
        status: 200,
        kind: "unknown",
        detail: parsed,
      });
    }

    const message = normalizeMessage(choice.message);
    return {
      message,
      finishReason: choice.finish_reason ?? null,
      usage: normalizeUsage(parsed.usage),
      model: parsed.model ?? req.model, // effective model (fallback may switch it)
      requestedModel: req.model,
      cacheInfo: parsed.cache_info,
      xCache: res.headers.get("X-Cache"),
      requestId,
      latencyMs: Date.now() - startedAt,
    };
  }
}

/** Map the wire message onto our `Message`, dropping gateway-only fields. */
function normalizeMessage(wire: WireMessage): Message {
  const toolCalls = (wire.tool_calls ?? [])
    .filter((tc) => tc && typeof tc.id === "string")
    .map((tc) => ({
      id: tc.id as string,
      type: "function" as const,
      function: {
        name: tc.function?.name ?? "",
        arguments: tc.function?.arguments ?? "{}",
      },
    }));

  const message: Message = {
    role: (wire.role as Message["role"]) ?? "assistant",
    content: wire.content ?? null,
  };
  // Preserve tool_calls — required when the assistant message is echoed back.
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  if (wire.tool_call_id) message.tool_call_id = wire.tool_call_id;
  return message;
}

function normalizeUsage(usage: Partial<TokenUsage> | null | undefined): TokenUsage {
  if (!usage) return emptyUsage();
  return {
    prompt_tokens: usage.prompt_tokens ?? 0,
    completion_tokens: usage.completion_tokens ?? 0,
    total_tokens: usage.total_tokens ?? 0,
  };
}
