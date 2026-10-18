# Agent Forge — Agent framework with a built-in execution harness for the Echo Gate LLM Gateway and others

Status: draft spec (v0.1)
Working repo name: `agent-forge` (rename freely)

## 1. Purpose

Build a reusable **agent harness** in TypeScript/Node that can run agents against
any OpenAI-compatible LLM endpoint, using **Echo Gate** (`http://localhost:8000`)
as the reference target. The harness owns the generic agent runtime (LLM client,
tool loop, tool registry/executor, run tracing, evals). The first agent built on
it, **Echo Ops**, operates and audits the Echo Gate gateway through the gateway's
own HTTP API.

Guiding principles:

- **Harness first, agents second.** The runtime is provider-agnostic; Echo Gate is
  just the first target, with its gateway-specific niceties (e.g. `cache_info`, the
  `service_name` field) isolated in an adapter layer.
- **Read-only before mutating.** The first agent only reads. Mutating tools come
  later behind an approval gate.
- **Deterministic tool boundaries, probabilistic reasoning.** Tool schemas and
  outputs are strictly typed; the model's choice of tools is what we evaluate.

## 2. Context: what Echo Gate provides and constrains

Echo Gate is an OpenAI-compatible LLM gateway with multi-provider routing, Redis +
Qdrant caching, Postgres tracing/usage (RLS per tenant), Celery background jobs,
and a usage/quota layer. Source: the `echo-gate` repo (`README.md`, `docs/`).

### 2.1 Capabilities the harness can rely on

- `POST /api/v1/chat/completions` is OpenAI-compatible and supports real function
  calling: `tools`, `tool_calls`, `tool_choice`
  (`auto` / `required` / `none` / a specific function), and
  `finish_reason: "tool_calls"`. Gemini is translated natively; OpenAI, Groq, and
  OpenRouter pass through.
- `response_format` (`json_object` / `json_schema`) for structured output.
- Multi-provider routing with an automatic fallback provider and tenacity retries.
- Auth + isolation: `X-API-Key` resolves to a tenant/user, Postgres RLS applies,
  RPM/TPM quota returns `429`, prepaid budget exhaustion returns `402`.
- Observability: every call is traced with a routing decision and per-stage
  latency. Read APIs: `/api/v1/gateway-requests` (list / get / by-hash),
  `/api/v1/analytics/dashboard`, `/api/v1/analytics/latency`.
- Usage/cost: `/api/v1/llm-usage/` and `POST /api/v1/llm-usage/calculate-costs`.
- Diagnostics: `POST /api/v1/chat/completions/exact-search`,
  `POST /api/v1/chat/completions/semantic-search`, `POST /api/v1/qdrant/search`,
  `POST /api/v1/qdrant/search/rrf`, `POST /api/v1/verifier/predict/rerank`.
- Cache introspection on every completion: `cache_info`
  (`source`, `score`, `cache_hit`, `intent`, `exact_hash`, `latency_breakdown`)
  plus the `X-Cache` response header.

### 2.2 Constraints the harness must design around

- **No streaming.** `stream` is accepted but ignored; responses are always a single
  JSON object. Tool-calling turns are full round trips — use generous timeouts.
- **No circuit breaker.** The gateway has only retries (`app/core/retry.py`) plus a
  single fallback. If a provider is hard-down, each call pays the timeout. A
  breaker is a new component (harness-side or gateway-side) — not yet decided.
- **`tools` bypasses the semantic cache** (by design, for determinism). The exact
  cache still applies. Agent tool-turns are therefore effectively uncached: expect
  real cost/latency and `source: "llm"` in traces.
- **Model allowlist per provider.** A fallback can change the effective model, so
  the harness must read `response.model` (and the trace's `provider`/`model`) back
  rather than assuming the requested model served the request.
- **Default quota is 10 RPM / 20 000 TPM.** A multi-step loop trips `429` quickly;
  the gateway quota rules must be raised for the agent's tenant/provider, or the
  harness must back off.
- **RLS scopes `/gateway-requests` to the caller's tenant.** A tenant-scoped agent
  only sees its own tenant's traces unless trusted headers are used.

## 3. First agent: Echo Ops (gateway operations & cache-quality agent)

Echo Ops answers operational questions about the gateway by calling the gateway's
own API: "Why was this request slow?", "What's my cache hit rate this week?",
"Which model costs the most?", "Are there false-positive cache hits?".

### 3.1 v1 capabilities (read-only)

1. **Health triage** — check `/health/ready`, `/health/worker`, `/health/celery`;
   report which backing dependency is degraded.
2. **Trace forensics** — list/filter traces (`routing_decision`, `min_latency_ms`,
   `has_error`, `evaluation_status`, `time_range`) → fetch one → explain the
   latency breakdown, routing decision, and where the time went.
3. **Cache performance** — pull dashboard `kpis` + `cache_performance`; compute hit
   rate and rough savings.
4. **Cost & usage** — query `/llm-usage/` + analytics `model_breakdown`; report
   spend by model/tenant over a time range.
5. **Cache-quality audit** — find traces with `evaluation_status=FAILED` /
   `is_false_positive=true` / low relevance or entailment; summarize and flag
   thresholds to review.
6. **Retrieval diagnostics** — for a prompt, run `/completions/exact-search` (and
   optionally `/completions/semantic-search`) and explain the hit/miss.

### 3.2 v2 capabilities (mutating, gated)

`create_api_key`, `revoke_api_key`, `queue_evaluation`
(`POST /gateway-requests/evaluate`), `calculate_costs`
(`POST /llm-usage/calculate-costs`). All behind an explicit approval/confirmation
step and a per-run mutation budget.

### 3.3 Why this is the right first agent

- **Zero external integrations** — its tools are the gateway's contract-tested HTTP
  API.
- **Exercises the harness's hard parts** — native tool calling, multi-step loops,
  JSON argument parsing, HTTP tool execution, error/backoff handling.
- **Verifiable** — answers are numeric and checkable, so evals are straightforward.
- **Safe** — read-only, runs unattended.
- **Dogfoods the gateway** — it uses the tracing/analytics the gateway provides.

### 3.4 Deliberately not first

A coding or research assistant has no tools (doesn't test the harness), and a full
dev agent needs repo/sandbox tooling that is far too broad for milestone 1.

## 4. Locked decisions

| Decision               | Choice                                       |
| ---------------------- | -------------------------------------------- |
| Harness language/stack | **TypeScript / Node**                        |
| First agent scope      | **Read-only v1**                             |
| Tool execution         | **In-process functions** (JSON-schema specs) |
| First target model     | **`openai/gpt-oss-20b` via Groq**            |
| Gateway base URL       | `http://localhost:8000` (configurable)       |

## 5. Harness architecture

```
src/
  core/
    types.ts             Message, ToolCall, ToolDef, AgentResult, RunEvent
    config.ts            env: GATEWAY_URL, GATEWAY_API_KEY, provider/model, ids, limits
    llm-client.ts        OpenAI-compatible client for Echo Gate (no streaming)
    agent-loop.ts        the tool-calling loop
    errors.ts            GatewayError + backoff policy (429/402/503/400)
    tools/
      registry.ts        registerTool(name, description, schema, handler)
      executor.ts        arg validation, timeout, error capture
    tracing/
      run-tracer.ts      run events, correlation IDs, cache_info capture
    gateway/
      gateway-client.ts  typed HTTP client for the gateway API
  tools/
    gateway/             one file per Echo Ops tool
      health.ts
      traces.ts
      analytics.ts
      usage.ts
      diagnostics.ts
  agents/
    echo-ops/
      agent.ts           system prompt + tool set
      tools.ts           binds gateway tools
      index.ts           CLI entry
  evals/
    cases/               golden trajectories
    runner.ts            trajectory assertions
  cli.ts                 echo-ops "why was request <hash> slow?"
tests/
```

The LLM client and loop are provider-agnostic. Gateway-specific behavior
(`service_name`, `cache_info`, the allowlist) lives in the gateway client/tools so
other targets can reuse the runtime.

## 6. LLM client contract

`POST ${GATEWAY_URL}/api/v1/chat/completions` with header `X-API-Key` and body:

```jsonc
{
  "service_name": "groq",
  "model": "openai/gpt-oss-20b",
  "messages": [/* ... */],
  "tools": [/* JSON-schema tool defs */],
  "tool_choice": "auto",
  "temperature": 0.2,
  "max_tokens": 1024,
}
```

The client:

- Parses `choices[0].message` (both `content` and `tool_calls`),
  `choices[0].finish_reason`, `usage`, and `cache_info`.
- **Reads the effective `model` back** (fallback may have switched it).
- Never assumes streaming.
- Propagates a per-call `X-Request-ID` and records `X-Cache`.
- Applies the backoff policy in §11.

## 7. Agent loop

```
messages = [system, user]
repeat up to MAX_STEPS:
  resp = chat({ messages, tools, tool_choice: "auto" })
  record(resp)                                # tokens, latency, cache_info

  msg = resp.choices[0].message
  push assistant message (preserving tool_calls)

  if msg has no tool_calls:
      return msg.content                      # final answer

  for each tool_call in msg.tool_calls:
      args   = JSON.parse(tc.function.arguments)   # validate with zod
      result = executor.run(tc)                    # timeout + try/catch
      push { role: "tool", tool_call_id: tc.id, content: json(result) }

error if MAX_STEPS exceeded
```

- Stop conditions: no tool calls, `MAX_STEPS`, token/cost budget, abort signal.
- Tool errors are returned as tool-result content (`{ok:false,error}`) so the model
  can self-correct instead of aborting the run.
- The assistant message sent back MUST preserve `tool_calls`, and `tool` messages
  MUST carry `tool_call_id` (the gateway schema supports both).

## 8. Tool interface

Each tool is a plain object with a name, description, JSON-schema parameters, and
an async handler. Transport-agnostic so it can later be wrapped as MCP.

```ts
interface ToolDef<A = unknown> {
  name: string;
  description: string;
  parameters: JSONSchema; // OpenAI function "parameters"
  handler: (args: A, ctx: ToolContext) => Promise<unknown>;
}
```

`registry.ts` collects tools and emits the OpenAI `tools` array. `executor.ts`
validates args (zod), enforces a per-tool timeout, and captures thrown errors as
structured results.

## 9. Echo Ops tool catalog (read-only v1)

| Tool                        | Gateway call                                  | Key args                                                                                      |
| --------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `gateway_health`            | `GET /api/v1/health/{ready,worker,celery}`    | —                                                                                             |
| `list_traces`               | `GET /api/v1/gateway-requests/`               | `routing_decision`, `min_latency_ms`, `has_error`, `evaluation_status`, `time_range`, `limit` |
| `get_trace`                 | `GET /api/v1/gateway-requests/{id}`           | `log_id`                                                                                      |
| `get_trace_by_hash`         | `GET /api/v1/gateway-requests/by-hash/{hash}` | `exact_hash`                                                                                  |
| `cache_dashboard`           | `GET /api/v1/analytics/dashboard`             | `time_range`                                                                                  |
| `latency_report`            | `GET /api/v1/analytics/latency`               | `time_range`                                                                                  |
| `list_usage`                | `GET /api/v1/llm-usage/`                      | `start_time`, `end_time`, `limit`                                                             |
| `recall_diagnostics`        | `POST /api/v1/chat/completions/exact-search`  | `model`, `messages`                                                                           |
| `rerank_check` _(optional)_ | `POST /api/v1/verifier/predict/rerank`        | `query`, `candidates`                                                                         |

v2 (gated): `create_api_key`, `revoke_api_key`, `queue_evaluation`,
`calculate_costs`.

## 10. Configuration

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

Secrets come from the environment (or a local `.env`), never committed.

## 11. Error & resilience policy

| Gateway status | Meaning                                   | Harness behavior                                             |
| -------------- | ----------------------------------------- | ------------------------------------------------------------ |
| `401`          | Missing/invalid API key                   | Fatal — fail fast with a clear message.                      |
| `429`          | RPM/TPM quota exceeded                    | Exponential backoff + retry; honor `Retry-After` if present. |
| `402`          | Prepaid budget exhausted                  | Fatal — stop the run.                                        |
| `400`          | Validation error / model not in allowlist | Fatal — the request is wrong; surface the detail.            |
| `503`          | Provider (and fallback) failed            | Backoff, then abort the run.                                 |
| `5xx`/timeout  | Transient                                 | Limited retries with jitter.                                 |

The gateway already retries and falls back, so the harness backs off rather than
double-retrying aggressively.

## 12. Observability & tracing

- Emit a **run record**: steps, tool calls + results, latency, tokens, cost, and the
  gateway `cache_info` per LLM call.
- Propagate `X-Request-ID` per LLM call so the run can be correlated with gateway
  traces; optionally fetch the trace by `exact_hash` afterward to attach the
  server-side latency breakdown.
- Store runs as JSONL for inspection and eval replay.

## 13. Evaluation

- **Trajectory assertions first:** given a fixed prompt, assert the expected tool
  sequence and key argument values, plus numeric answers within tolerance.
- Groq is non-deterministic, so avoid exact-text assertions.
- **CI uses recorded fixtures; a separate job runs a live smoke test** against the
  gateway. This keeps CI hermetic while still catching integration drift.

## 14. Gateway integration prerequisites & gotchas

- **Raise the quota rule** above the 10 RPM default for the agent's
  tenant/provider/model (add an `llm_quota_rules` row) before multi-step runs.
- Create an API key for the agent (`POST /api/v1/admin/api-keys/`) and put it in
  `GATEWAY_API_KEY`.
- **`tools` bypasses the semantic cache** → traces show `source: "llm"`; expected.
- **Tenant scoping:** the ops agent sees only its own tenant's traces (RLS).
- **Allowlist:** only `openai/gpt-oss-20b` / `openai/gpt-oss-safeguard-20b` are
  valid for `groq`; a fallback may switch the effective model.
- **No streaming:** set client timeouts well above
  `LLM_PROVIDER_TIMEOUT_SECONDS` (15s), since a tool turn can chain provider calls.
- **Treat tool output as untrusted** (trace fields, prompt text). Keep it in tool
  messages; never concatenate it into the system prompt.

## 15. Milestones

- **M0** — scaffold (TS config, env, `gateway_health` tool) + single-turn smoke test.
- **M1** — LLM client + loop with one tool; verify a real tool-call round trip
  through Groq via the gateway.
- **M2** — registry + executor + full read-only Echo Ops toolset.
- **M3** — run tracing (capture `cache_info`/usage/cost, propagate `X-Request-ID`)
  - CLI (`echo-ops "why was request <hash> slow?"`).
- **M4** — evals + fixtures + CI.
- **M5** — hardening: budget/max-step guards, 429/402 handling, injection review.

## 16. Open questions / future work

1. **Circuit breaker:** the gateway only has retries + fallback. Add a breaker in
   the harness client, in the gateway, or skip for now?
2. **Evals:** confirm the fixtures-in-CI + live-smoke split.
3. **Cross-tenant ops:** is tenant-scoped visibility enough, or does the ops agent
   need trusted cross-tenant access?
4. **Streaming:** out of scope until the gateway implements it.
5. **MCP:** expose the Echo Ops toolset over MCP later (tool interface is designed
   to allow this) for reuse by other MCP-capable clients.
6. **Multi-agent:** the runtime is generic; additional agents should only need to
   supply a system prompt + tool set.
