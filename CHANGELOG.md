# Changelog

All notable changes to agent-forge are documented here. Format based on
[Keep a Changelog](https://keepachangelog.com/); versioning per
[RELEASES.md](./RELEASES.md) (SemVer; pre-1.0 minors may break).

## [Unreleased]

Roadmap work not yet in a release: M2 (full read-only Echo Ops toolset),
M3 (run tracer + JSONL + CLI, `X-Request-ID` correlation plumbing), M4 (evals +
fixtures + CI), M5 (hardening, mutation approval gate). See
[ROADMAP.md](./ROADMAP.md).

## [0.1.0] — 2026-10-18

First milestone pair shipped: M0 scaffold + M1 LLM client/agent loop, verified
live end-to-end through Echo Gate → Groq.

### Added

- **M0** project scaffold: `package.json` / `tsconfig.json` (strict,
  `noUncheckedIndexedAccess`, `noImplicitOverride`, `noFallthroughCasesInSwitch`)
  / `tsconfig.build.json` / `vitest.config.ts` / `.env.example` / `.gitignore`.
- **Configuration**: `loadConfig` / `AppConfig` / `ConfigError` — zod-validated
  env parsing that aggregates every invalid field at once; defaults per SPEC §10.
- **Core types**: `Message`, `ToolCall`, `ToolDef`, `ToolContext`, `OpenAIToolDef`,
  `TokenUsage`, `AgentResult`, `RunEvent` (+ `emptyUsage`/`addUsage`).
- **Tool system**: `ToolRegistry` (register/get, `toOpenAI()` OpenAI-compatible
  `tools[]` emitter) and `ToolExecutor` (zod arg validation, per-tool timeout,
  **never throws**, structured `ToolOutcome`s with codes `unknown_tool`,
  `invalid_json`, `invalid_arguments`, `timeout`, `aborted`, `tool_error`).
- **Gateway transport**: `GatewayClient` (`X-API-Key` injection, timeouts,
  `requestDetailed` header access, three-endpoint `health()` fan-out with
  degraded-subsystem aggregation) and the `gateway_health` tool.
- **Errors**: `GatewayError`, `GatewayErrorKind`, `classifyStatus`,
  `parseRetryAfterMs` (Retry-After seconds-or-HTTP-date), `fatal` semantics per
  SPEC §11.
- **M1 — LLM client**: `LlmClient` — OpenAI-compatible, no streaming; effective
  model read-back (gateway fallback may switch model); `cache_info` +
  `X-Cache` capture; per-call `X-Request-ID` minting (`af-<uuid>`);
  `ChatRequest`/`ChatResponse`/`LlmLike` (injectable for tests).
- **M1 — Agent loop**: `runAgent` implementing SPEC §7 — `tool_calls` preserved
  on assistant echo, `tool_call_id` on tool messages, stop conditions
  (final answer / abort / token budget / MAX_STEPS / thrown error), tool errors
  fed back as `{ok:false,error}` for model self-correction, `RunEvent` stream.
- **M1 — Echo Ops agent**: `agents/echo-ops` (read-only v1 system prompt, tool
  binding, runtime wiring; M1 toolset = `gateway_health` only; `service_name`
  and `session_id` injected as `extraBody`, keeping core gateway-free).
- **Infrastructure**: vitest harness (7 hermetic test files, 44 tests) with
  fully injected egress (`fetchImpl` / `LlmLike` fakes); `npm run smoke` live
  probe against a real gateway.
- **Live verification** (2026-10-18): round trip via Echo Gate → Groq —
  LLM step 1 → `gateway_health` (~1 s, ok) → LLM step 2 → correct final answer
  naming the real Celery degradation; 2 steps, 905 tokens.
- **Environment provisioning** for M1 (echo-gate side): admin key
  (`agent-forge-m1`), tenant API key (`acme`/`ops-agent`), and quota rule 131 —
  60 RPM / 200 000 TPM for `acme` × `groq` × `openai/gpt-oss-20b`.

### Changed

- `ToolContext.requestId` renamed to `ToolContext.runId` (2026-10-19, pre-1.0
  break): tools receive the **run-scoped** identifier; per-request IDs live on
  `RunEvent.llm_call.requestId` and returned `ChatResponse.requestId`. Rationale
  in [docs/adr/0002-run-id-request-id-correlation.md](./docs/adr/0002-run-id-request-id-correlation.md).
- The gateway's server-side correlation ID is deliberately **not** consumed:
  it exists only inside gateway internal logs and is not exposed on responses
  (ADR 0002).

### Rejected / not implemented

- CommonJS build output (ESM-only by design, ADR 0001); streaming (gateway
  ignores `stream`); circuit breaker (open question, ROADMAP).

### Documented findings (M1)

- Gateway traces do **not** persist `X-Request-ID`; durable correlation uses
  `cache_info.exact_hash` → `GET /api/v1/gateway-requests/by-hash/{hash}`.
- Exact cache replay of an identical prompt in ~15–30 ms keyed on model + user
  text (independent of `max_tokens`); tool turns bypass semantic caching by
  design.
- `reasoning_content` from `openai/gpt-oss-20b` consumes `max_tokens` and is
  dropped from the transcript.
