# API Reference

Public surface = whatever `src/index.ts` re-exports (`main: dist/index.js`,
`types: dist/index.d.ts`). Everything below ships in the current build; treat
signatures as unstable until 1.0 (see [RELEASES.md](./RELEASES.md)).

- [Configuration](#configuration)
- [Errors](#errors)
- [Tool system](#tool-system)
- [Gateway transport](#gateway-transport)
- [LLM client](#llm-client)
- [Agent loop](#agent-loop)
- [Echo Ops agent](#echo-ops-agent)

Minimal end-to-end example (a fake LLM in place of the gateway):

```ts
import { ToolRegistry, ToolExecutor, runAgent } from "agent-forge";

const llm: FakeLlm /* implements LlmLike */ = /* injectable fake or LlmClient */ 
const registry = new ToolRegistry();
registry.register({
  name: "greet",
  description: "Greet someone by name",
  schema: z.object({ name: z.string() }),
  handler: async ({ name }) => `hello ${name}`,
});

const result = await runAgent("greet someone", {
  llm,
  registry,
  executor: new ToolExecutor(registry, 10_000),
  systemPrompt: "You are a greeter.",
  model: "openai/gpt-oss-20b",
});
// → { ok: true, content: "hello sam", steps: 2, usage: { … } }
```

## Configuration

### `loadConfig(env?: EnvLike): AppConfig`

Validates + defaults an env-like record (`process.env` by default). Throws
`ConfigError` aggregating every invalid field at once. Normalizes `GATEWAY_URL`
trailing slashes. Full variable table: [CONFIGURATION.md](./CONFIGURATION.md).

```ts
export type EnvLike = Record<string, string | undefined>;
export type AppConfig = z.infer<typeof EnvSchema>;
export class ConfigError extends Error {
  constructor(public readonly issues: string[]);
}
```

## Errors

### `GatewayError`

```ts
export type GatewayErrorKind =
  | "auth"        // 401/403 — fatal, fail fast
  | "budget"      // 402     — fatal, stop the run
  | "validation"  // 400/422 — fatal, surface detail
  | "quota"       // 429     — backoff + retry (honor Retry-After)
  | "unavailable" // 503     — backoff, then abort
  | "transient"   // 5xx/timeout — limited retries with jitter
  | "network"     // connection failure (status 0)
  | "unknown";

export class GatewayError extends Error {
  readonly status: number;          // 0 = network/no HTTP status
  readonly kind: GatewayErrorKind;  // inferred from status unless provided
  readonly retryAfterMs?: number;   // parsed from Retry-After
  readonly detail?: unknown;        // response body excerpt, cache_info, etc.
  get fatal(): boolean;             // auth | budget | validation
}
```

### `parseRetryAfterMs(header: string | null): number | undefined`

Parses `Retry-After` (integer seconds **or** HTTP-date) into milliseconds;
`undefined` when absent/unparseable. Clamped ≥ 0.

### `classifyStatus(status: number): GatewayErrorKind`

Status → kind mapping used by `GatewayError` when no explicit kind is given.

## Tool system

### `ToolDef<A>`

```ts
export interface ToolDef<A = unknown> {
  name: string;
  description: string;
  schema: z.ZodType<A>;    // authoritative for argument validation
  parameters?: JSONSchema; // OpenAI function "parameters"; derived from schema when omitted
  handler: (args: A, ctx: ToolContext) => Promise<unknown>;
  timeoutMs?: number;      // per-tool override of the executor default (TOOL_TIMEOUT_MS)
  mutating?: boolean;      // reserved for v2 approval gate (M5)
  // transport-agnostic; designed to be wrappable as MCP later
}
```

### `ToolContext`

```ts
export interface ToolContext {
  signal?: AbortSignal;  // aborted when the run is cancelled or budgets exhausted
  runId: string;         // run-scoped identifier shared by that run's tool calls
}
```

`runId` is deliberately *run*-scoped (one run makes many LLM calls, each with
its own `requestId` on `RunEvent.llm_call`) — ADR 0002.

### `ToolRegistry`

```ts
class ToolRegistry {
  register(tool: ToolDef): void;
  get(name: string): ToolDef | undefined;
  toOpenAI(): OpenAIToolDef[];  // [{type:"function", function:{name, description, parameters}}]
}
```

The OpenAI `parameters` object is derived from the tool's zod `schema` unless
`parameters` is set explicitly (only when the model-facing surface must differ).

### `ToolExecutor` + outcomes

```ts
type ToolErrorCode = "unknown_tool" | "invalid_json" | "invalid_arguments"
                   | "timeout" | "aborted" | "tool_error";

export interface ToolOutcome {
  toolCallId: string;
  name: string;
  ok: boolean;
  result?: unknown;
  error?: { code: ToolErrorCode; message: string };
  durationMs: number;
}

class ToolExecutor {
  constructor(registry: ToolRegistry, defaultTimeoutMs?: number /* 10_000 */);
  run(call: ToolCall, ctx: ToolContext): Promise<ToolOutcome>; // NEVER throws
  toToolMessage(outcome: ToolOutcome): Message; // {role:"tool", tool_call_id, content: json({ok,result|error})}
}
```

`run()` never throws (ADR 0003): unknown tool, unparseable JSON, failing zod
validation, timeout (`ToolTimeoutError`), abort, and handler crashes all become
structured outcomes with distinct codes, then tool-message content of the shape
`{ok:true,result}` / `{ok:false,error}` so the model can self-correct.

## Gateway transport

### `GatewayClient`

```ts
export interface GatewayClientOptions {
  baseUrl: string;
  apiKey: string;           // sent as X-API-Key on every request
  fetchImpl?: typeof fetch; // injectable for tests
  timeoutMs?: number;       // default 30_000
}

class GatewayClient {
  request<T>(path, init, signal?): Promise<T>;          // throws GatewayError on !ok
  requestDetailed<T>(path, init, signal?): Promise<{data: T; headers: Headers}>;
  get<T>(path, signal?): Promise<T>;
  health(signal?): Promise<GatewayHealth>;
}
```

Notes:

- `X-API-Key` is always merged in; caller-provided headers win on conflict.
- Gateway timeouts surface as `GatewayError` with `kind: "network"`,
  `status: 0` — see [docs/troubleshooting.md](./docs/troubleshooting.md).
- Non-OK responses throw `GatewayError` carrying `detail` (first 2 000 chars of
  the body), `retryAfterMs` when `Retry-After` is present. `204` → `undefined`.

### `GatewayHealth` / `ServiceCheck`

```ts
export interface ServiceCheck { ok: boolean; status: number; detail?: string }
export interface GatewayHealth {
  ready: ServiceCheck; worker: ServiceCheck; celery: ServiceCheck;
  degraded: string[];  // subsystem names not reporting ok — the "which dependency" answer
}
```

`health()` fans out over `GET /api/v1/health/{ready,worker,celery}` with
`Promise.all` and never throws (per-check `NetworkError → ok:false, status:0`).

## LLM client

### `LlmClient`

```ts
export interface LlmClientOptions {
  baseUrl: string;
  apiKey: string;
  extraBody?: Record<string, unknown>; // gateway niceties (e.g. service_name) merged under params
  fetchImpl?: typeof fetch;
  timeoutMs?: number;                  // default 120_000 — tool turns chain provider calls
}

export type ToolChoice = "auto" | "required" | "none";

export interface ChatRequest {
  model: string;
  messages: Message[];
  tools?: OpenAIToolDef[];
  toolChoice?: ToolChoice;   // default "auto"
  temperature?: number;
  maxTokens?: number;
  sessionId?: string;        // binds a cache scope
}

export interface ChatResponse {
  message: Message;          // content and/or tool_calls, preserved as sent
  finishReason: string | null;
  usage: TokenUsage;         // {prompt_tokens, completion_tokens, total_tokens}
  model: string;             // EFFECTIVE model — a fallback may have switched it
  requestedModel: string;
  cacheInfo?: unknown;       // Echo Gate cache introspection, verbatim when present
  xCache: string | null;     // X-Cache response header
  requestId: string;         // af-<uuid>; sent as X-Request-ID, echoed in gateway logs
  latencyMs: number;
}

export interface LlmLike { chat(req: ChatRequest, signal?: AbortSignal): Promise<ChatResponse>; }

class LlmClient implements LlmLike { constructor(opts: LlmClientOptions); chat(req, signal?): Promise<ChatResponse>; }
```

Contract highlights: no streaming (gateway always returns one JSON object);
`tool_calls` preserved verbatim; gateway-only wire fields (e.g.
`reasoning_content`) are dropped from the transcript; missing `choices[0]`
throws a `GatewayError` with `kind: "unknown"`.

## Agent loop

### `runAgent(userMessage, options): Promise<AgentResult>`

```ts
export interface AgentLoopOptions {
  llm: LlmLike;
  registry: ToolRegistry;
  executor: ToolExecutor;
  systemPrompt: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  maxSteps?: number;        // default 8
  budgetTokens?: number;    // default 50_000
  sessionId?: string;
  signal?: AbortSignal;     // cancels between steps and during calls
  onEvent?: (event: RunEvent) => void;
  runId?: string;           // default run-<Date.now()>
}

export interface AgentResult {
  ok: boolean;
  content: string | null;
  steps: number;
  usage: TokenUsage;
  error?: string;
}
```

Event stream (useful for tracing/audit — richer capture lands in M3, including
JSONL persistence):

```ts
export type RunEvent =
  | { type: "run_started"; runId: string; agent: string; startedAt: string }
  | { type: "llm_call"; step: number; model: string; latencyMs: number;
      usage: TokenUsage; cacheInfo?: unknown; requestId: string }
  | { type: "tool_call"; step: number; name: string; ok: boolean;
      durationMs: number; error?: string }
  | { type: "run_finished"; runId: string; ok: boolean; steps: number;
      usage: TokenUsage; error?: string };
```

Helpers: `emptyUsage()`, `addUsage(a, b)` for cumulative token accounting.

## Echo Ops agent

```ts
export interface CreateEchoOpsOptions {
  config: AppConfig;
  fetchImpl?: typeof fetch;
}

export interface EchoOpsAgent {
  systemPrompt: string;         // ECHO_OPS_SYSTEM_PROMPT
  registry: ToolRegistry;       // gateway_health today; full read-only set in M2
  run(message: string, opts?: { signal?: AbortSignal; onEvent?: (e: RunEvent) => void }):
    Promise<AgentResult>;
}

export function createEchoOpsAgent(opts: CreateEchoOpsOptions): EchoOpsAgent;
export const ECHO_OPS_SYSTEM_PROMPT: string;
```

`createEchoOpsAgent` is the wiring example to copy for new agents: config →
`GatewayClient` (+ `LlmClient` with `service_name` as `extraBody`) → registry
→ executor → `runAgent`. A second agent needs only a prompt + tool list
(SPEC §16.6).
