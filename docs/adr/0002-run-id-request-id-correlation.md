# ADR 0002 — Run ID vs Request ID vs gateway correlation ID

- **Status:** accepted
- **Date:** 2026-10-19 (pre-1.0 rename) / documented 2026-10-20
- **Scope:** identifier semantics across harness↔gateway correlation
- **Context code:** `ToolContext.runId` (`types.ts`), `RunEvent.llm_call.requestId`
  (`types.ts`), `X-Request-ID` minting in `llm-client.ts`,
  `runId` wiring in `agent-loop.ts`

## Context

Three distinct identifiers are in play, and a pre-M1 shape conflated two of
them:

1. **Run scope** — one agent run, spanning up to `MAX_STEPS` LLM calls.
2. **HTTP request scope** — one client→gateway→provider call.
3. **Gateway-internal fan-out** — the request's life inside Echo Gate's own
   services.

Before M1 the harness had a single `ToolContext.requestId`, threaded unchanged
through every tool call of a run. That was really a *run-scoped* number wearing
a *request-scoped* name — and the name collided directly with what Echo Gate
means by `X-Request-ID`. Meanwhile the gateway itself has a server-generated
`X-Correlation-ID` used only for its internal, server-to-server log fan-out.

## Decision

The three scopes are resolved as three distinct, explicitly-owned identifiers
with different *directions of trust*:

| Identifier | Scope | Minted by | Direction | Surface |
| --- | --- | --- | --- | --- |
| `runId` | whole run | harness | local only | `ToolContext.runId`, `RunEvent.run_started/run_finished` |
| `requestId` (`af-<uuid>`) | one LLM call | harness | **seeded out**, then read back | `X-Request-ID` header; `ChatResponse.requestId`; `RunEvent.llm_call.requestId`; gateway app logs (`[req_id=…]`) |
| `exact_hash` | one prompt ↔ one trace row | gateway | **returned inbound** | `cache_info.exact_hash` → `/gateway-requests/by-hash/{hash}` |
| gateway correlation ID | internal fan-out | gateway servers | neither — never exposed | gateway logs only; **deliberately unused here** |

Concretely:

- `ToolContext.requestId` → **renamed `ToolContext.runId`** (breaking, done
  pre-1.0), with a doc comment explaining the run/request distinction.
- `LlmClient.chat()` mints `requestId = af-<randomUUID>()` **per call** and
  records it on `ChatResponse` + the `llm_call` event.
- The gateway's correlation ID is intentionally *not* consumed: it is not in
  responses, doesn't exist in any machine-readable surface we touch, and adding
  a field for it would be dead weight today and a lie after the gateway's
  exposure policy changes.

## Trust/verification property (why "seeded then read back")

The client does not own `X-Request-ID`: a load balancer may set or replace it.
So anything that depends on it must **confirm the echoed value**, not assume
the seed survived. Today's join is `ChatResponse.requestId` (what we sent) with
the gateway's published behavior ("echoes and logs it, does not persist on
trace rows"), and the fallback for durable correlation is the `exact_hash`
join (M1 finding — recorded in the
[CHANGELOG 0.1.0](../../CHANGELOG.md) findings). Future M3 work will read the response's request
ID back and treat divergence as signal, not silently continue with the seed.

## Alternatives considered

- **Keep the single `ToolContext.requestId`, document it as run-scoped.**
  Rejected: leaves the worst kind of trap — a field whose name matches a
  gateway concept but never matches a gateway request. First debugging session
  grepping gateway logs for a tool-run ID would have "found" nothing.
- **Put a `correlationId` field next to `requestId` in `ToolContext`.** Rejected:
  both for the wrong-shape reason (correlation ID is gateway-internal, and the
  protocol direction is a *response* — not a tool-caller input) and because
  `ToolContext` is the *core* surface that must stay gateway-agnostic
  (SPEC §5). The gateway adapter hides peers-by-their-own-names.
- **Drop `runId` and derive it from `X-Request-ID` per step.** Rejected for
  costing us the only identifier that is *all ours*: local, agent-owned, and
  stable across the whole run, which is what evals/records/tracing need.

## Consequences

**Positive:**

- One run ↔ N request IDs is representable (`llm_call` events), evals can
  assert on request behavior *per step* rather than per run.
- The never-mine-server-names floor: nothing in `core/` pretends to own a
  gateway-internal identifier.
- `runId` gives tool handlers and future mutation-approval flows (M5) a stable
  run-scoped anchor.

**Negative / costs:**

- `ToolContext` field rename is a breaking change (accepted pre-1.0, with the
  risk noted in CHANGELOG).
- Durable trace joins depend on `cache_info.exact_hash` until the gateway
  persists `X-Request-ID` upstream (see ROADMAP — flagged to raise upstream).
- Callers must learn the run/request distinction; `AGENTS.md` + API_REFERENCE
  hold the load.
