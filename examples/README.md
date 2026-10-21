# Examples

Runnable, copy-paste-startable examples for agent-forge. **None shipped yet**
— they land alongside the milestones that make them meaningful. File an issue
if one would unblock you.

## Conventions (agreed in advance)

- Each example = one folder: `README.md` + runnable TypeScript, no local `npm
  install` needed (repo-local deps, run via `npx tsx examples/<name>/main.ts`
  from the repo root, consistent with `npm run smoke`).
- Examples import from `../src` (until the package is published, then from
  `"agent-forge"`).
- **No secrets required to run**: every example that touches a live gateway
  reads `.env` (`GATEWAY_URL`, `GATEWAY_API_KEY`) and prints a clear hint when
  they are missing. Hermetic examples (mock fetch / fake LLM) must run green
  with zero env.
- Tests must not depend on examples; examples must not skip typecheck
  (`npm run typecheck` covers `src` + `tests` today; add examples paths when
  the first one lands).

## Planned list

| Example | Status | Covers |
| --- | --- | --- |
| `health-check` | 🚧 *next* | `GatewayClient.health()` + the `gateway_health` tool directly; hermetic variant with a mock fetch and a live variant via `npm run smoke`-style `.env` |
| `custom-tool-loop` | ⬜ | Define a `ToolDef` (zod schema → OpenAI parameters), register, drive `runAgent` with a fake `LlmLike` — shows the never-throws executor contract end to end (ADR 0003) |
| `echo-ops-live` | ⬜ | `createEchoOpsAgent` against a real gateway: health triage, `onEvent` capture, stop conditions in action |
| `trace-correlation` | ⬜ | Per-call `X-Request-ID` seeding, `cache_info.exact_hash` → `/gateway-requests/by-hash/{hash}` join (ADR 0002 finding) |
| `run-records` | ⬜ | `RunEvent` stream → JSONL (the M3 tracer's shape, demonstrated manually) |
| `budget-guard` | ⬜ | `MAX_STEPS` / `RUN_BUDGET_TOKENS` / `TOOL_TIMEOUT_MS` interplay and the failure envelopes |

## Until examples exist

The closest runnable references today:

- `src/smoke.ts` — live single-turn probe through `createEchoOpsAgent`.
- `src/agents/echo-ops/agent.ts` — the full wiring pattern to copy for a new
  agent (prompt + tool list only, SPEC §16.6).
- `tests/*.test.ts` — hermetic usage of every public API surface, including
  failure-path envelopes.
