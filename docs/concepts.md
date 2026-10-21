# Concepts

The vocabulary and moving parts of a run. For the layer diagram and module map
see [ARCHITECTURE.md](../ARCHITECTURE.md).

## Agents and runs

- An **agent** is a definition: system prompt + tool set + generation settings
  (`agents/echo-ops/` is the reference implementation — "a new agent is only a
  prompt + tool list").
- A **run** is one execution of that agent against one user message:
  `runAgent(userMessage, opts)` → `AgentResult { ok, content, steps, usage, error? }`.
- A **step** is one LLM call plus the tool round it triggers. `MAX_STEPS`
  (default 8) caps steps per run.

## The tool-calling cycle (SPEC §7)

```
messages = [system, user]
repeat up to MAX_STEPS:
  resp = chat({messages, tools, tool_choice: "auto"})
  usage += resp.usage                     # account tokens every call
  push resp.message (assistant, tool_calls preserved)
  if no tool_calls → done: content is the answer
  for each tool_call:
      outcome = executor.run(tool_call, { runId, signal })
      push { role:"tool", tool_call_id, content: json({ok, result|error}) }
  if usage.total_tokens > budgetTokens → stop (budget exhausted)
```

Two wire-format invariants areLoad-bearing (the gateway rejects otherwise):

- assistant messages sent back preserve their `tool_calls`;
- tool messages carry `tool_call_id`.

## Tools

A tool is a plain object — no framework forcing:

```ts
interface ToolDef<A = unknown> {
  name: string;
  description: string;
  schema: z.ZodType<A>;      // authoritative validation, source of truth for parameters
  parameters?: JSONSchema;   // model-facing OpenAI "parameters" (derived from schema when omitted)
  handler: (args: A, ctx: ToolContext) => Promise<unknown>;
  timeoutMs?: number;        // per-tool override; otherwise executor default (TOOL_TIMEOUT_MS)
  mutating?: boolean;        // reserved for the v2 approval gate — nothing mutating ships yet
}
```

- `ToolRegistry` accumulates `ToolDef`s and emits the OpenAI `tools[]` payload.
- `ToolExecutor` runs a call: JSON-parse arguments → zod-validate → enforce
  timeout → invoke handler. **It never throws** (ADR 0003): every failure mode
  is a structured `ToolOutcome` (`unknown_tool`, `invalid_json`,
  `invalid_arguments`, `timeout`, `aborted`, `tool_error`), rendered back to
  the model as `{ok:false, error:{code,message}}` so it can adjust and retry.
- `ToolContext.signal` carries cancellation; `ToolContext.runId` scopes the
  tool call to its run (identifier model: ADR 0002).

## Stop conditions (priority order)

1. **Final answer** — model returns a message with no `tool_calls`.
2. **Abort signal** — before an LLM call, or during tool execution.
3. **Token budget** — cumulative `usage.total_tokens` > `budgetTokens`
   checked after each step (run continues *through* the step that crossed, the
   next step is not started).
4. **MAX_STEPS** — no final answer within the cap → failed result.
5. **Thrown error** — e.g. a fatal `GatewayError` (401/402/400) fails the run.

Every stop emits `RunEvent.run_finished` with `ok`/`steps`/`usage`/`error`.

## Events and observability

`onEvent` receives a `RunEvent` per lifecycle moment:
`run_started` → per step: `llm_call` (model, latency, usage, `cacheInfo`,
`requestId`) and `tool_call` (name, ok, duration, error) → `run_finished`.
This stream is the seed of M3's run tracer (JSONL records) and eval replay.

## Identifier model (see ADR 0002)

| ID | Scope | Direction |
| --- | --- | --- |
| `runId` | whole run | generated locally, local-only |
| `requestId` (`af-<uuid>`) | one LLM HTTP call | seeded out as `X-Request-ID`; echoed by gateway logs |
| `exact_hash` | one prompt ↔ one trace row | gateway-issued via `cache_info` — the durable trace join |
| correlation ID | gateway-internal | server-to-server logs only, not used here |

## Where gateway specifics live

The core (`core/`) speaks only OpenAI-compatible shapes. Echo Gate-specific
inputs — `service_name` (= provider), `session_id` (cache scope), model
allowlist, `cache_info` introspection — are injected at wiring time
(`agents/echo-ops/agent.ts`) or captured opaquely (`cacheInfo?: unknown`).
Consequences of that design, and the gateway's cache behavior itself:
[caching.md](./caching.md).
