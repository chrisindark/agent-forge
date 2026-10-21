# AGENTS.md

Working rules for AI coding assistants operating in this repo. Human
contributors: same rules, see [CONTRIBUTING.md](./CONTRIBUTING.md).

## What this repo is

An agent framework with a built-in execution harness (TypeScript, Node ≥ 20,
**strict ESM**), currently at **M0 + M1** per `ROADMAP.md` — meaning:
`ToolRegistry`/`ToolExecutor`, `GatewayClient`, `LlmClient`, `runAgent` loop,
and the first read-only agent (`agents/echo-ops`) exist. M2–M5 (full toolset,
tracing/CLI, evals/CI, hardening) do **not** exist yet — do not implement
"ahead" of a milestone unless asked.

## Verify before you claim done

```bash
npm run typecheck   # must be clean
npm test            # must stay green (44 tests / 7 files as of 2026-10-20)
npm run build       # dist/ must keep compiling
```

Never claim completion on a test run alone — typecheck and build are cheap and
catch different drift.

## Hard rules (violations will be considered bugs)

1. **Relative imports end in `.js`, even inside `.ts` sources**
   (ADR 0001). This repo is `"type": "module"` + NodeNext. Writing `./foo.ts`
   or extensionless relative imports is a tsc error (TS5097 / TS2835). Bare
   specifiers (`zod`, `node:crypto`, `vitest/config`) need no suffix.
2. **`core/` is provider- and gateway-agnostic.** No gateway-shaped fields
   (`cache_info`, `service_name`, allowlist, session semantics) inside
   `core/types.ts` or any `core/` module. Gateway specifics enter via
   `extraBody`/options at the wiring layer (`agents/echo-ops/agent.ts`).
3. **`ToolExecutor.run` never throws** (ADR 0003). Failures are structured
   `ToolOutcome`s (`unknown_tool | invalid_json | invalid_arguments | timeout |
   aborted | tool_error`). If you add a failure mode, add a code + test, not a
   throw.
4. **Loop invariants** (SPEC §7): assistant messages pushed back MUST preserve
   `tool_calls`; tool messages MUST carry `tool_call_id`.
5. **Tests are hermetic.** No test performs network I/O. Fake egress via
   `fetchImpl` or the `LlmLike` interface. Don't add live-network tests; live
   verification belongs to `npm run smoke`.
6. **Tools are read-only until prompted otherwise.** The v1 Echo Ops catalog is
   read-only by design; mutating tools are gated work for M5 — don't add a
   mutating tool without the approval-gate design attached.
7. **Don't read `.env` values or commit secrets**; `.env.example` is the only
   committed env-related file.
8. **Don't weaken tsconfig strictness** or delete checks to make errors go away.

## Where things live

| Concern | File | Notes |
| --- | --- | --- |
| Public surface | `src/index.ts` | Only this is exported from the package. New public API = add a re-export line here + update `API_REFERENCE.md`. |
| Env validation | `src/core/config.ts` | zod schema; **aggregates** all field errors at once. |
| Loop semantics | `src/core/agent-loop.ts` | Stop conditions in priority order: final answer → abort → token budget → maxSteps → thrown error. |
| Chat wire format | `src/core/llm-client.ts` | Effective model read-back; drops `reasoning_content`; mints `af-<uuid>` request IDs. |
| Transport + auth | `src/core/gateway/gateway-client.ts` | `X-API-Key` always merged; timeout → `GatewayError{status:0, kind:"network"}`. |
| Error taxonomy | `src/core/errors.ts` | `GatewayErrorKind` + `fatal` getter; statuses 401/402/400 fatal. |
| Tool registry/executor | `src/core/tools/registry.ts`, `executor.ts` | Schema-derived OpenAI `parameters`; never-throws executor. |
| Echo Ops wiring | `src/agents/echo-ops/` | Copy this shape for a new agent ("prompt + tool list only"). |
| Tests | `tests/*.test.ts` | vitest; `globals: false`; explicit imports from `"vitest"`. |

## Doc map (update docs when behavior moves)

Root: [README](./README.md), [ROADMAP](./ROADMAP.md),
[ARCHITECTURE](./ARCHITECTURE.md), [CONFIGURATION](./CONFIGURATION.md),
[DEVELOPMENT](./DEVELOPMENT.md), [API_REFERENCE](./API_REFERENCE.md),
[SECURITY](./SECURITY.md), [RELEASES](./RELEASES.md),
[CONTRIBUTING](./CONTRIBUTING.md), [CHANGELOG](./CHANGELOG.md).

`docs/`: getting-started, concepts, authentication, caching, token-accounting,
rate-limiting, analytics, deployment, troubleshooting, faq, `adr/`.

## Known findings that look like bugs but aren't (M1)

- The gateway **echoes** `X-Request-ID` into app logs but does not persist it on
  `/gateway-requests` rows. Durable run↔trace correlation uses
  `cache_info.exact_hash` → `/gateway-requests/by-hash/{hash}` instead.
- `tenant_id`/`user_id` in the chat body would **override** API-key identity
  (body wins); the client deliberately never sends them.
- `openai/gpt-oss-20b` emits `reasoning_content` that consumes `max_tokens` —
  tight budgets can yield `content: ""` with `finish_reason: "length"`.
- Tool turns bypass the semantic cache by design (`source: "llm"` in traces) —
  expected cost, not a caching bug.
- Quota is `min()` across all matching rules (not max) — a pre-existing narrow
  rule on another tenant does not bind us, but verify effective limits.

## Style

- JSDoc file headers that state purpose + SPEC/PLANS section; update them when
  behavior changes.
- Match surrounding structure/naming exactly; don't reformat unrelated lines.
- Leave the existing test structure alone (hermetic, per-file naming
  `<module>.test.ts`).
