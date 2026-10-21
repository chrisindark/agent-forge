# Roadmap

Consolidates the original `SPEC.md` §15 and `PLANS.md` §6/§9–§11 (folded into
this docs set on 2026-10-20 — history preserved in git before the docs
restructure). This file summarizes status and scope; the granular progress log
for shipped milestones lives in [CHANGELOG.md](./CHANGELOG.md).

## Milestones

| Milestone | Scope | Status |
| --- | --- | --- |
| **M0** — scaffold | TS config, env loading (zod), `ToolRegistry`/`ToolExecutor`, `GatewayClient`, `gateway_health` tool, hermetic smoke tests | ✅ Complete (2026-10-18) |
| **M1** — LLM client + loop | `LlmClient` (per-call `X-Request-ID`, effective-model read-back, `cache_info`/`X-Cache` capture, no streaming), `runAgent` loop, Echo Ops agent definition, live round-trip verification via Groq | ✅ Complete (2026-10-18) |
| **M2** — full toolset | Registry + executor at scale; complete read-only Echo Ops tool catalog (table below) | ⬜ Next |
| **M3** — run tracing + CLI | Run tracer (capture `cache_info`/usage/cost), JSONL run records, `X-Request-ID` correlation plumbing, `echo-ops "why was request <hash> slow?"` CLI | ⬜ Planned |
| **M4** — evals + CI | Trajectory assertions, recorded fixtures in CI, separate live-smoke job | ⬜ Planned |
| **M5** — hardening | Budget/max-step guards, 429/402 handling, prompt-injection review, mutation budget + approval gate (v2 tools) | ⬜ Planned |

Current verification baseline: `npm run typecheck` clean, **44 tests passing**
across 7 hermetic files, `npm run build` emits `dist/` (ESM + declarations).

## M2 tool catalog (originally SPEC §9)

| Tool                        | Gateway call                                  | Key args                                                                                      |
| --------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `gateway_health`            | `GET /api/v1/health/{ready,worker,celery}`    | — (✅ already shipped, M0)                                                                    |
| `list_traces`               | `GET /api/v1/gateway-requests/`               | `routing_decision`, `min_latency_ms`, `has_error`, `evaluation_status`, `time_range`, `limit` |
| `get_trace`                 | `GET /api/v1/gateway-requests/{id}`           | `log_id`                                                                                      |
| `get_trace_by_hash`         | `GET /api/v1/gateway-requests/by-hash/{hash}` | `exact_hash`                                                                                  |
| `cache_dashboard`           | `GET /api/v1/analytics/dashboard`             | `time_range`                                                                                  |
| `latency_report`            | `GET /api/v1/analytics/latency`               | `time_range`                                                                                  |
| `list_usage`                | `GET /api/v1/llm-usage/`                      | `start_time`, `end_time`, `limit`                                                             |
| `recall_diagnostics`        | `POST /api/v1/chat/completions/exact-search`  | `model`, `messages`                                                                           |
| `rerank_check` _(optional)_ | `POST /api/v1/verifier/predict/rerank`        | `query`, `candidates`                                                                         |

## M4 evaluation approach (originally SPEC §13)

- **Trajectory assertions first:** given a fixed prompt, assert the expected
  tool sequence and key argument values, plus numeric answers within tolerance.
- **No exact-text assertions** — Groq is non-deterministic.
- **CI uses recorded fixtures; a separate job runs a live smoke test** against
  the gateway. Keeps CI hermetic while still catching integration drift.

## v2 mutating toolset (gated)

The mutating tool catalog (`create_api_key`, `revoke_api_key`,
`queue_evaluation`, `calculate_costs`) lands behind an explicit approval step
and a per-run mutation budget. Nothing mutating exists in the tree today.

## Open questions (SPEC §16 / PLANS §8)

1. **Circuit breaker** — the gateway only retries + single fallback. Add one
   harness-side, gateway-side, or defer? (Not yet decided.)
2. **Evals split** — confirm fixtures-in-CI vs live-smoke separation.
3. **Cross-tenant ops** — is tenant-scoped (RLS) visibility enough, or does the
   ops agent eventually need trusted cross-tenant access?
4. **Streaming** — out of scope until the gateway implements it.
5. **MCP** — expose the toolset over MCP later; the `ToolDef` interface was
   designed to allow it.
6. **Multi-agent** — runtime is generic; a new agent should only need a system
   prompt + tool set (`agents/echo-ops/` is the template).
7. **Framework choice** — decided: plain TypeScript for the core, NestJS
   reserved for a later `server/` control plane wrapping `AgentRunner`
   ([ADR 0004](./docs/adr/0004-plain-ts-core-nestjs-deferred.md)).

## Pending upstream items (M1 findings)

- The gateway echoes and logs `X-Request-ID` but does **not** persist it on
  `/gateway-requests` rows; durable run↔trace correlation currently goes
  through `cache_info.exact_hash` → `GET /gateway-requests/by-hash/{hash}`.
  Worth raising upstream so `list_traces` can filter by request ID directly.
