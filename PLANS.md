# Agent Forge — Build Plan

Derived from `SPEC.md` (draft v0.1) and `README.md`. Working state: repo contains
only docs; implementation starts at M0.

## 1. Product shape

Three layers + a public entry point (per README):

| Layer | Verb | Owns |
| --- | --- | --- |
| **Agent (definition)** | Create | Identity, instructions/objectives, model + generation settings, tool declarations & permissions, memory/knowledge config, reusable agent definitions |
| **AgentRuntime** | Execute | Reasoning/action loop, LLM requests through Echo Gate, tool execution & result handling, context assembly & conversation state, stop conditions / iteration limits / timeouts |
| **AgentHarness** | Control | Tool permission enforcement, execution budgets, tracing/events/audit logs, retries & failure handling, test fixtures, evaluations, reproducibility |
| **AgentRunner** | — | Public entry point that composes the three |

Mapping to SPEC.md: *Create* → agent definition + tool registry · *Execute* →
agent loop + LLM client · *Control* → policies, budgets, tracing, evals.

## 2. What we are building

### 2.1 Core runtime (`src/core/`) — Execute

| Piece | File | Responsibility |
| --- | --- | --- |
| Types | `types.ts` | `Message`, `ToolCall`, `ToolDef`, `AgentResult`, `RunEvent` |
| Config | `config.ts` | Env-driven: `GATEWAY_URL`, `GATEWAY_API_KEY`, provider/model, tenant/user/session ids, `MAX_STEPS`, `TEMPERATURE`, `MAX_TOKENS`, `TOOL_TIMEOUT_MS`, `RUN_BUDGET_TOKENS` |
| LLM client | `llm-client.ts` | OpenAI-compatible, **no streaming**; reads effective `model` back (fallback may switch it); propagates `X-Request-ID`; records `X-Cache` |
| Agent loop | `agent-loop.ts` | call → parse `tool_calls` → execute → push `tool` messages → repeat until no tool calls / `MAX_STEPS` / token budget / abort signal |
| Errors | `errors.ts` | `GatewayError` + backoff policy (see §5) |

Loop invariants:
- Assistant message sent back MUST preserve `tool_calls`; `tool` messages MUST carry `tool_call_id`.
- Tool errors are returned as tool-result content (`{ok:false, error}`) so the model can self-correct instead of aborting.

### 2.2 Tool system (`src/core/tools/`) — Create + Control

- `registry.ts` — `registerTool(name, description, schema, handler)`; emits the OpenAI `tools` array.
- `executor.ts` — zod arg validation, per-tool timeout, error capture into structured results.
- Tool interface is transport-agnostic so it can be wrapped as MCP later:

```ts
interface ToolDef<A = unknown> {
  name: string;
  description: string;
  parameters: JSONSchema; // OpenAI function "parameters"
  handler: (args: A, ctx: ToolContext) => Promise<unknown>;
}
```

### 2.3 Gateway adapter (`src/core/gateway/` + `src/tools/gateway/`)

Typed HTTP client for Echo Gate, one file per Echo Ops tool. All gateway-specific
behavior (`cache_info`, `service_name`, allowlist, RLS tenant scoping) is isolated
here so the runtime stays provider-agnostic.

**Read-only v1 tool catalog (9):**

| Tool | Gateway call | Key args |
| --- | --- | --- |
| `gateway_health` | `GET /api/v1/health/{ready,worker,celery}` | — |
| `list_traces` | `GET /api/v1/gateway-requests/` | `routing_decision`, `min_latency_ms`, `has_error`, `evaluation_status`, `time_range`, `limit` |
| `get_trace` | `GET /api/v1/gateway-requests/{id}` | `log_id` |
| `get_trace_by_hash` | `GET /api/v1/gateway-requests/by-hash/{hash}` | `exact_hash` |
| `cache_dashboard` | `GET /api/v1/analytics/dashboard` | `time_range` |
| `latency_report` | `GET /api/v1/analytics/latency` | `time_range` |
| `list_usage` | `GET /api/v1/llm-usage/` | `start_time`, `end_time`, `limit` |
| `recall_diagnostics` | `POST /api/v1/chat/completions/exact-search` | `model`, `messages` |
| `rerank_check` _(optional)_ | `POST /api/v1/verifier/predict/rerank` | `query`, `candidates` |

**v2 (mutating, gated):** `create_api_key`, `revoke_api_key`, `queue_evaluation`
(`POST /gateway-requests/evaluate`), `calculate_costs` — behind an explicit
approval step + per-run mutation budget.

### 2.4 First agent: Echo Ops (`src/agents/echo-ops/`)

- `agent.ts` — system prompt + tool set
- `tools.ts` — binds gateway tools
- `index.ts` — CLI entry

Capabilities v1: health triage, trace forensics, cache performance, cost & usage,
cache-quality audit, retrieval diagnostics. Adding a second agent should require
only a system prompt + tool set.

### 2.5 Observability (`src/core/tracing/run-tracer.ts`) — Control

- Run record: steps, tool calls + results, latency, tokens, cost, `cache_info` per LLM call.
- Correlate with gateway traces via `X-Request-ID`; optionally fetch the trace by `exact_hash` afterward for the server-side latency breakdown.
- Persist runs as **JSONL** for inspection and eval replay.

### 2.6 Evals (`src/evals/`) — Control

- Trajectory assertions first: expected tool sequence + key argument values + numeric answers within tolerance.
- **No exact-text assertions** — Groq is non-deterministic.
- CI runs recorded fixtures (hermetic); a separate job runs a live smoke test against the gateway.

### 2.7 CLI (`src/cli.ts`)

`echo-ops "why was request <hash> slow?"`

## 3. Locked decisions (SPEC §4)

| Decision | Choice |
| --- | --- |
| Harness language/stack | TypeScript / Node |
| First agent scope | Read-only v1 |
| Tool execution | In-process functions (JSON-schema specs) |
| First target model | `openai/gpt-oss-20b` via Groq |
| Gateway base URL | `http://localhost:8000` (configurable) |

## 4. Configuration (SPEC §10)

```
GATEWAY_URL=http://localhost:8000
GATEWAY_API_KEY=eg_...
AGENT_PROVIDER=groq
AGENT_MODEL=openai/gpt-oss-20b
AGENT_TENANT_ID=acme
AGENT_USER_ID=ops-agent
AGENT_SESSION_ID=                       # optional; binds a cache scope
MAX_STEPS=8
TEMPERATURE=0.2
MAX_TOKENS=1024
TOOL_TIMEOUT_MS=10000
RUN_BUDGET_TOKENS=50000                 # optional hard stop
```

Secrets from environment / local `.env`, never committed.

## 5. Error & resilience policy (SPEC §11)

| Status | Meaning | Harness behavior |
| --- | --- | --- |
| `401` | Missing/invalid API key | Fatal — fail fast |
| `429` | RPM/TPM quota exceeded | Exponential backoff + retry; honor `Retry-After` |
| `402` | Prepaid budget exhausted | Fatal — stop the run |
| `400` | Validation / model not in allowlist | Fatal — surface the detail |
| `503` | Provider (and fallback) failed | Backoff, then abort |
| `5xx` / timeout | Transient | Limited retries with jitter |

The gateway already retries + falls back, so the harness backs off rather than
double-retrying aggressively.

## 6. Milestones

- **M0** — scaffold (TS config, env, `gateway_health` tool) + single-turn smoke test.
- **M1** — LLM client + loop with one tool; verify a real tool-call round trip through Groq via the gateway.
- **M2** — registry + executor + full read-only Echo Ops toolset.
- **M3** — run tracing (capture `cache_info`/usage/cost, propagate `X-Request-ID`) + CLI.
- **M4** — evals + fixtures + CI.
- **M5** — hardening: budget/max-step guards, 429/402 handling, injection review.

## 7. Gateway integration prerequisites

- Raise the quota rule above the 10 RPM / 20 000 TPM default for the agent's
  tenant/provider/model (`llm_quota_rules` row) before multi-step runs.
- Create an API key (`POST /api/v1/admin/api-keys/`) → `GATEWAY_API_KEY`.
- `tools` bypasses the semantic cache (by design) → traces show `source: "llm"`; expected.
- Tenant scoping via RLS: the ops agent sees only its own tenant's traces.
- Allowlist: `openai/gpt-oss-20b` / `openai/gpt-oss-safeguard-20b` valid for `groq`; fallback may switch the effective model.
- No streaming: set client timeouts well above `LLM_PROVIDER_TIMEOUT_SECONDS` (15s); a tool turn can chain provider calls.
- **Tool output is untrusted** (trace fields, prompt text): keep it in tool messages, never concatenate into the system prompt.

## 8. Open questions

1. **Circuit breaker:** harness-side, gateway-side, or skip for now?
2. **Evals:** confirm fixtures-in-CI + live-smoke split.
3. **Cross-tenant ops:** is tenant-scoped visibility enough, or does the ops agent need trusted cross-tenant access?
4. **Streaming:** out of scope until the gateway implements it.
5. **MCP:** expose the Echo Ops toolset over MCP later (tool interface already allows it).
6. **Multi-agent:** runtime is generic; additional agents should only need a system prompt + tool set.
7. **Framework choice:** NestJS vs plain Node — see decision recorded below.

## 9. Framework decision

**Decision: plain TypeScript for the core (M0–M5); NestJS reserved for a later
API/control-plane layer.**

Rationale:

- The v0.1 deliverable is a **library + CLI**, not a web service: `AgentRunner` is
  imported, tools are in-process functions, the interface is `cli.ts`. NestJS's
  HTTP/DI/module layer adds cost without serving the core.
- The core must stay **transport-free** for the planned MCP wrap and for hermetic
  eval fixtures (call `agent-loop` directly, no test-module bootstrap).
- The README's **Control** layer (dashboard, run APIs, approval gates for v2
  mutating tools, policy/audit DI) is where NestJS earns its keep — add `server/`
  wrapping `AgentRunner` when we need an observable, controllable API.

Target layout:

```
src/
  core/        # zero framework deps: types, config, llm-client, loop, registry, executor, tracer, errors
  tools/       # gateway adapter + Echo Ops tools (pure functions)
  agents/      # agent definitions (echo-ops first)
  cli.ts
server/        # (later) NestJS control-plane wrapping core
tests/
```

## 10. M0 scope (in progress)

- [x] Project scaffold: `package.json`, `tsconfig`, vitest, `.env.example`, `.gitignore`
- [x] `src/core/config.ts` — zod-validated env loading
- [x] `src/core/types.ts` — `Message`, `ToolCall`, `ToolDef`, `AgentResult`, `RunEvent`
- [x] `src/core/tools/registry.ts` — `registerTool` → OpenAI `tools` array
- [x] `src/core/tools/executor.ts` — arg validation, timeout, structured error capture
- [x] `src/core/gateway/gateway-client.ts` — minimal typed HTTP client
- [x] `src/tools/gateway/health.ts` — `gateway_health` tool
- [x] Single-turn smoke test (hermetic tests w/ mock fetch + optional live smoke script)

**M0 status: complete.** `npm run typecheck` clean, 28 tests passing, `npm run
build` emits `dist/`, `npm run smoke` exits 1 with a clear hint while Echo Gate
is down (it is not running locally yet) and will exercise `gateway_health` +
a single-turn completion once the gateway is up with a real `GATEWAY_API_KEY`.
