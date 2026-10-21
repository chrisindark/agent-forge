# Architecture

Describes the system as it exists today (M0 + M1), consolidated from the
original `SPEC.md` and `PLANS.md` (2026-10-20; see
[Document provenance](#document-provenance)). For scope/sequencing see
[ROADMAP.md](./ROADMAP.md).

## Layer model

```
┌──────────────────────────────────────────────────────────────┐
│  AgentRunner (planned entry point; today createEchoOpsAgent) │
├──────────────┬──────────────────────────┬────────────────────┤
│ Agent        │ AgentRuntime             │ AgentHarness       │
│ (Create)     │ (Execute)                │ (Control)          │
│              │                          │                    │
│ identity,    │ reasoning/action loop,   │ budgets, events,   │
│ prompt, tool │ LLM requests, tool exec, │ tracing, retries,  │
│ decls, perms │ ctx assembly, stops      │ evals, reproduc.   │
├──────────────┴──────────────────────────┴────────────────────┤
│              Gateway adapter (Echo Gate specifics)           │
└──────────────────────────────────────────────────────────────┘
```

Mapping to code:

- *Create* → agent definitions (`src/agents/echo-ops/`) + `ToolRegistry`
- *Execute* → `agent-loop.ts` + `llm-client.ts`
- *Control* → budgets/stop conditions in `agent-loop.ts`; event emission via
  `RunEvent`; timeouts in `ToolExecutor`/clients; evals + rich tracing land in
  M3–M5.

## Module map (as implemented)

```
src/
  index.ts                  public surface — everything else is re-exported here
  core/                     provider-agnostic runtime; ZERO gateway knowledge
    types.ts                Message, ToolCall, ToolDef, ToolContext, AgentResult, RunEvent
    config.ts               zod-validated env config (CONFIGURATION.md)
    errors.ts               GatewayError + status classification + Retry-After parsing
    agent-loop.ts           runAgent() — the SPEC §7 loop
    llm-client.ts           LlmClient — OpenAI-compatible chat, no streaming
    tools/
      registry.ts           ToolRegistry — accumulate ToolDefs, emit OpenAI tools[]
      executor.ts           ToolExecutor — validate args (zod), timeout, structured outcomes
    gateway/
      gateway-client.ts     GatewayClient — typed HTTP transport (auth header, timeouts, health)
  agents/echo-ops/
    prompt.ts               ECHO_OPS_SYSTEM_PROMPT (read-only rules, untrusted-output rules)
    tools.ts                createEchoOpsTools() — binds Echo Ops tools to a GatewayClient
    agent.ts                createEchoOpsAgent() — wiring: config → clients → registry → runAgent
  tools/gateway/
    health.ts               gateway_health tool (M0; more tools land in M2)
```

Dependency direction (enforced by convention and the layer comment in
`types.ts`): `core/` must never import from `agents/` or `tools/gateway/`, and
core types must never gain gateway-shaped fields. Gateway-specific inputs
(`service_name`, `session_id`) enter as `extraBody`/options in the wiring layer
(`agents/echo-ops/agent.ts`), keeping the runtime target-agnostic.

## Locked decisions

Constants the rest of this document assumes (originally SPEC §4):

| Decision               | Choice                                       |
| ---------------------- | -------------------------------------------- |
| Harness language/stack | **TypeScript / Node** (≥ 20, strict ESM)     |
| First agent scope      | **Read-only v1**                             |
| Tool execution         | **In-process functions** (JSON-schema specs) |
| First target model     | **`openai/gpt-oss-20b` via Groq**            |
| Gateway base URL       | `http://localhost:8000` (configurable)       |
| Core framework         | Plain TypeScript; NestJS reserved for a later control plane ([ADR 0004](./docs/adr/0004-plain-ts-core-nestjs-deferred.md)) |

## First target: Echo Gate

The reference gateway is an OpenAI-compatible LLM gateway with multi-provider
routing, Redis + Qdrant caching, Postgres tracing/usage (RLS per tenant),
Celery background jobs, and a usage/quota layer.

**Capabilities the harness relies on** (originally SPEC §2.1):

- `POST /api/v1/chat/completions` with native function calling: `tools`,
  `tool_calls`, `tool_choice` (`auto`/`required`/`none`/specific function),
  `finish_reason: "tool_calls"`.
- `response_format` (`json_object` / `json_schema`) for structured output.
- Multi-provider routing with automatic fallback provider and retries.
- Auth + isolation: `X-API-Key` resolves to a tenant/user; RLS applies; RPM/TPM
  quota → `429`; prepaid budget exhausted → `402`.
- Observability read APIs: `/gateway-requests` (list / get / by-hash),
  `/analytics/dashboard`, `/analytics/latency`; usage/cost endpoints.
- Diagnostics endpoints (exact/semantic search, Qdrant search).
- Cache introspection on every completion (`cache_info`) + the `X-Cache`
  header.

**Constraints that shaped the design** (originally SPEC §2.2), each with its
consequence:

| Constraint | Consequence in this codebase |
| --- | --- |
| **No streaming** (`stream` accepted but ignored) | `LlmClient` never streams; 120 s default timeout because tool turns chain provider calls |
| **No circuit breaker** (retries + single fallback only) | Harness backs off conservatively, never double-retries aggressively; breaker is an open question ([ROADMAP](./ROADMAP.md)) |
| **`tools` bypasses the semantic cache** | Tool turns are effectively uncached, `source: "llm"` ([docs/caching.md](./docs/caching.md)) |
| **Model allowlist per provider; fallback may switch the model** | Harness always reads the *effective* `model` back (`ChatResponse.model`) |
| **Default quota 10 RPM / 20 000 TPM** | A quota rule must be provisioned before multi-step runs ([docs/rate-limiting.md](./docs/rate-limiting.md)) |
| **RLS scopes trace reads to the caller's tenant** | Cross-tenant ops need the gateway's trusted-header mechanism (open question) |

## First agent: Echo Ops

Echo Ops answers operational questions about the gateway — *by calling the
gateway's own HTTP API*: "Why was this request slow?", "What's my cache hit
rate this week?", "Which model costs the most?", "Are there false-positive
cache hits?".

- **v1 (read-only, lives in the read-only system prompt):** health triage,
  trace forensics, cache performance, cost & usage, cache-quality audit,
  retrieval diagnostics. The toolset that implements this lands across M2.
- **v2 (mutating, gated):** `create_api_key`, `revoke_api_key`,
  `queue_evaluation`, `calculate_costs` — behind an explicit approval step and
  a per-run mutation budget (M5). Nothing mutating exists in the tree today.

**Why this was the right first agent** (originally SPEC §3.3): zero external
integrations (its tools are contract-tested HTTP), it exercises the harness's
hard parts (native tool calling, multi-step loops, arg parsing, error
handling), answers are numeric and checkable (evaluable), it is read-only and
runs unattended, and it dogfoods the gateway's own observability.

**Deliberately not first** (§3.4): a coding/research assistant has no tools
(and thus doesn't test the harness); a full dev agent needs repo/sandbox
tooling far too broad for the first milestone.

## Boundaries and data flow

```
runAgent()
  → LlmClient.chat()  ──HTTP──▶ Echo Gate ──▶ provider (e.g. Groq)
  ◀── ChatResponse { message, tool_calls?, usage, model, cacheInfo, xCache, requestId }
  → ToolExecutor.run(toolCall, { runId, signal })
  ◀── ToolOutcome { ok, result | error, durationMs }     (never throws — ADR 0003)
  → tool message pushed back into transcript → repeat or finish
```

### The agent loop contract (SPEC §7)

- Assistant messages are pushed back **preserving `tool_calls`**; tool messages
  **must carry `tool_call_id`** — both required by the gateway schema.
- Stop conditions, first match wins:
  1. model returns no `tool_calls` → success with `content`
  2. abort signal fires (between steps, before LLM call, or during tool exec)
  3. cumulative `usage.total_tokens` exceeds `budgetTokens`
  4. `maxSteps` exhausted → failed result
  5. a thrown error (e.g. fatal `GatewayError`) → failed result with its message
- Tool failures never abort the run; they are fed back as
  `{ok:false,error}` content (ADR 0003) so the model can self-correct.

## Identifier model (ADR 0002)

| Identifier | Scope | Who mints | Where it appears |
| --- | --- | --- | --- |
| `runId` | one agent run | harness (`run-<epoch>` default) | `RunEvent.run_started/run_finished`, `ToolContext.runId` |
| `requestId` | one LLM HTTP call | harness (`af-<uuid>`) | sent as `X-Request-ID`, `RunEvent.llm_call.requestId`, gateway app logs (`[req_id=…]`) |
| `exact_hash` | one prompt → one trace row | gateway (`cache_info.exact_hash`) | durable run↔trace join (`GET /gateway-requests/by-hash/{hash}`) |
| correlation ID | gateway-internal fan-out | gateway servers | gateway internal logs only; **not exposed on responses**, deliberately unused here |

The request ID is *seeded, then verified*: the LB or gateway may override it, so
anything that depends on it must confirm the echo rather than assume it. Durable
correlation uses `exact_hash` (M1 finding — see the "Documented findings"
section of the [CHANGELOG 0.1.0](./CHANGELOG.md) entry and
[ADR 0002](./docs/adr/0002-run-id-request-id-correlation.md)).

## Error taxonomy (SPEC §11)

| `GatewayError.kind` — `auth` (401/403), `budget` (402), `validation`
(400/422), `quota` (429), `unavailable` (503), `transient` (5xx/timeout),
`network` (connection failure, status 0), `unknown`. `err.fatal` is true for
`auth`/`budget`/`validation` → fail fast, no retry. `quota` honors
`Retry-After`; the harness backs off conservatively because Echo Gate already
retries and falls back internally. Full behavior table:
[docs/troubleshooting.md](./docs/troubleshooting.md).

Tool-level errors are orthogonal: `ToolExecutor` returns codes
`unknown_tool | invalid_json | invalid_arguments | timeout | aborted |
tool_error` as structured outcomes instead of throwing.

## Testing architecture

All tests are hermetic: `fetch` and the LLM are injected fakes
(`fetchImpl`, `LlmLike`); nothing in `tests/` performs network I/O. The live
path is exercised separately via `npm run smoke` against a real gateway. See
[DEVELOPMENT.md](./DEVELOPMENT.md) for how this is enforced.

## Decisions

Recorded in [docs/adr/](./docs/adr/):

- [ADR 0001 — ESM + NodeNext and `.js` relative imports](./docs/adr/0001-esm-nodenext-js-extensions.md)
- [ADR 0002 — Run ID vs request ID vs gateway correlation ID](./docs/adr/0002-run-id-request-id-correlation.md)
- [ADR 0003 — Tool executor never throws](./docs/adr/0003-tools-never-throw.md)
- [ADR 0004 — Plain TypeScript core; NestJS reserved](./docs/adr/0004-plain-ts-core-nestjs-deferred.md)

## Document provenance

`SPEC.md` and `PLANS.md` were consolidated into this docs set on 2026-10-20
(the pre-consolidation narrative is preserved in git history, before the docs
restructure commit). `src/` JSDoc headers and some doc prose still cite
`SPEC §N` / `PLANS §N` as historical provenance — this is where each of those
sections now lives:

| SPEC § | Now lives in |
| --- | --- |
| §1 Purpose & principles | [README](./README.md) (principles) |
| §2 Echo Gate capabilities & constraints | This file — *First target: Echo Gate* + topical docs |
| §3 Echo Ops (first agent) | This file — *First agent: Echo Ops* |
| §4 Locked decisions | This file — *Locked decisions* |
| §5 Architecture | This file (layer model, module map) |
| §6 LLM client contract | [API_REFERENCE](./API_REFERENCE.md) (LLM client) |
| §7 Agent loop | [docs/concepts](./docs/concepts.md) + this file (loop contract) |
| §8 Tool interface | [API_REFERENCE](./API_REFERENCE.md) (tool system) |
| §9 Tool catalog | [ROADMAP](./ROADMAP.md) (M2 scope) |
| §10 Configuration | [CONFIGURATION](./CONFIGURATION.md) |
| §11 Errors & resilience | [docs/troubleshooting](./docs/troubleshooting.md) + this file |
| §12 Observability & tracing | [docs/analytics](./docs/analytics.md) |
| §13 Evaluation | [ROADMAP](./ROADMAP.md) (M4) |
| §14 Prerequisites & gotchas | [docs/deployment](./docs/deployment.md), [docs/getting-started](./docs/getting-started.md), [SECURITY](./SECURITY.md) |
| §15 Milestones | [ROADMAP](./ROADMAP.md) |
| §16 Open questions | [ROADMAP](./ROADMAP.md) |

| PLANS § | Now lives in |
| --- | --- |
| §1 Product shape | [README](./README.md) (layer table) + this file (layer model) |
| §2 Components & invariants | This file (module map, loop contract) |
| §6 / §10 / §11 Milestone logs | [ROADMAP](./ROADMAP.md) status + [CHANGELOG](./CHANGELOG.md) 0.1.0 |
| §9 Framework decision | [ADR 0004](./docs/adr/0004-plain-ts-core-nestjs-deferred.md) |
| Everything else | Mapped identically to the SPEC rows above |
