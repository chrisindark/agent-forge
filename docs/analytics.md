# Analytics

Two different data sources, two different jobs:

1. **Gateway analytics** — Echo Gate's own aggregate views (existing API,
   toolset lands in M2).
2. **Run records** — what *this* harness records about its own runs (partial
   today; JSONL + cost in M3).

## 1. Gateway-side analytics (via tools, M2)

Endpoints the harness consumes (SPEC §3.1 / §9):

| Tool | Endpoint | Purpose |
| --- | --- | --- |
| `cache_dashboard` | `GET /api/v1/analytics/dashboard` | `kpis` + `cache_performance` — hit rate, rough savings |
| `latency_report` | `GET /api/v1/analytics/latency` | latency distributions per `time_range` |
| `list_usage` | `GET /api/v1/llm-usage/` | spend/historical usage rows (`start_time`, `end_time`, `limit`) |
| `list_traces` | `GET /api/v1/gateway-requests/` | filter by `routing_decision`, `min_latency_ms`, `has_error`, `evaluation_status`, `time_range`, `limit` |
| `get_trace` / `get_trace_by_hash` | `.../gateway-requests/{id}` / `/by-hash/{hash}` | one trace: latency breakdown, routing decision, where time went |

Echo Ops capabilities built **on** those tools (v1, read-only): trace
forensics ("why was this request slow?"), cache performance, cost & usage
(spend by model/tenant over a window), cache-quality audit
(`evaluation_status=FAILED`, `is_false_positive`), retrieval diagnostics
(exact/semantic search for a prompt's cache outcome).

RLS note: analytics reads are **tenant-scoped** by the API key —
cross-tenant aggregation is not available without the gateway's trusted-header
mechanism (open question, SPEC §16.3).

## 2. Run records (harness-side)

### What exists now

The `onEvent` stream (`RunEvent`) gives you, per run:
`run_started` → per step `llm_call {model, latencyMs, usage, cacheInfo,
requestId}` / `tool_call {name, ok, durationMs, error?}` → `run_finished
{ok, steps, usage, error?}`.

Persist it yourself for now — e.g. log to a `.jsonl`:

```ts
import { appendFileSync } from "node:fs";
import { createEchoOpsAgent, loadConfig } from "../src/index.js";

const events: unknown[] = [];
const result = await createEchoOpsAgent({ config: loadConfig() })
  .run("health check?", { onEvent: (e) => events.push(e) });
appendFileSync("runs.jsonl",
  JSON.stringify({ result, events, finishedAt: new Date().toISOString() }) + "\n");
```

### What M3 will add

- `src/core/tracing/run-tracer.ts` as the single owner of run records.
- **JSONL persistence** for inspection and **eval replay** (M4 replays a
  recorded trajectory as fixtures).
- Cost: tokens → USD via `/api/v1/llm-usage/calculate-costs`, mapped back to
  the `RunEvent.llm_call` rows by `requestId`.
- Durable run↔trace join: `cache_info.exact_hash` →
  `/gateway-requests/by-hash/{hash}` (request-ID-only joins don't survive
  current gateway behavior; see ADR 0002).

## A note on `exact_hash` joins (M1 finding)

The gateway echoes `X-Request-ID` into its application logs and it lands as
`llm_call.requestId` on our events, but the **trace rows** under
`/gateway-requests/` do not carry the request ID (as of 2026-10-18). Upstream
fix would enable `list_traces` filtering by request ID; until then, the hash
join is the only durable path. Worth raising upstream (noted in
[ROADMAP.md](../ROADMAP.md)).
