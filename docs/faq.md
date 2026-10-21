# FAQ

Fast answers; deep dives link to the topical doc.

## Why does every relative import in the sources end with `.js`, even in `.ts` files?

Because this package is ESM (`"type": "module"`) with `moduleResolution:
NodeNext`. Node's ESM resolver requires exact file extensions, and TypeScript
never rewrites import specifiers when emitting — so the extension must be what
the *runtime* needs. tsc maps a `.js` specifier back to the sibling `.ts` at
typecheck time. Writing `./foo.ts` (TS5097) or extensionless (TS2835) is a
compile error. Full rationale: [ADR 0001](./adr/0001-esm-nodenext-js-extensions.md).

## Why no CommonJS build?

Deliberate (ADR 0001). ESM is the direction; maintaining a dual build for a 0.1
library isn't worth the failure modes. CJS consumers need Node ≥ 22's
`require(esm)` or a dynamic `import()`.

## Why is there no streaming?

Echo Gate accepts `stream` but **ignores it** — completions are always one
JSON object (SPEC §2.2). Tool-calling turns are full round trips regardless;
that's why `LlmClient`'s default timeout is 120 s rather than 30 s. Revisit
when the gateway gains real streaming (open question, SPEC §16.4).

## My tool turn shows `source: "llm"` and wasn't cached — bug?

No. Any request carrying `tools` bypasses the **semantic cache** by gateway
design (determinism). The **exact cache** still applies — an identical prompt
can replay in ~15–30 ms. See [caching.md](./caching.md).

## `response.model` differs from what I requested — is that wrong?

Expected in fallback scenarios. The gateway may route your call to the
fallback provider, changing the effective model within the allowlist. The
harness always reads `response.model` back (`ChatResponse.model`) and records
the requested model separately (`requestedModel`). Assuming the requested
model served the request is a bug in *your* code, not the harness.

## Why doesn't the harness use the gateway's `X-Correlation-ID`?

It's never exposed to us: correlation IDs exist only in Echo Gate's internal
logs (server-to-server fan-out) and are not returned on responses, so there is
nothing to capture. Correlation-to-trace on the harness side uses the echoed
`X-Request-ID` (for logs) and `cache_info.exact_hash` (durable row lookup).
Decision record: [ADR 0002](./adr/0002-run-id-request-id-correlation.md).

## What's the difference between `runId` and `requestId`?

- `runId` — one value per agent run, shared by every tool call in
  `ToolContext`; it exists so tool handlers and logs can say "part of run X".
- `requestId` (`af-<uuid>`) — one per LLM HTTP call (a run makes up to
  `MAX_STEPS` of them), sent as `X-Request-ID`, recorded on each
  `RunEvent.llm_call` and on `ChatResponse.requestId`.

Naming history: pre-M1 a single `ToolContext.requestId` played the `runId` role
and was renamed before anything depended on the collision. ADR 0002.

## Can I run tools against something other than Echo Gate?

Yes — the core is provider-agnostic. `LlmClient` speaks the OpenAI-compatible
surface and `service_name`/`session_id` — the only Echo Gate-isms — are
injected as `extraBody` options by the wiring layer, not baked into core.
Swapping gateways means a new wiring module + tool set. Allowlist/RLS behavior
is server-side, so plan accordingly.

## Can I add my own tools / a second agent?

Tools: plain `ToolDef` objects registered on any `ToolRegistry` — see
[CONTRIBUTING.md](../CONTRIBUTING.md) ("Adding a tool"). Second agent: copy
`agents/echo-ops/` — a system prompt, a tool list, and wiring; the runtime
takes nothing more (SPEC §16.6). Mutating tools wait for the M5 approval-gate
design.

## Is the tool interface compatible with MCP later?

Designed to be: `ToolDef` is transport-agnostic (name/schema/handler) and
`ToolExecutor`'s structured outcomes map cleanly onto MCP tool semantics
(SPEC §16.5). Wrapping in an MCP server is planned, not started.

## Where does cost accounting live?

Tokens only today (`usage` on results/events; budgets are in tokens). USD
conversion requires the gateway's pricing APIs and is planned for M3's tracer
([analytics.md](./analytics.md), [ROADMAP.md](../ROADMAP.md)).

## What do the tests check without a gateway?

44 hermetic tests: config validation/aggregation, registry → OpenAI schema
derivation, executor failure modes (never-throw contract), health
fan-out/degraded aggregation, LLM wire normalization (effective model,
`cache_info`, `reasoning_content` drop, request-ID minting), and loop stop
conditions (final answer / abort / budget / MAX_STEPS / fatal error).
Live behavior is exercised separately via `npm run smoke`.
