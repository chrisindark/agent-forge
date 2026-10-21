# Caching

What Echo Gate caches, what the harness observes, and the behaviors that look
like bugs but are design. Field-level detail on `cache_info` below.

## Two caches

| Cache | What it keys on | Applies to tool turns? |
| --- | --- | --- |
| **Exact cache** | model + user text (M1 finding; independent of `max_tokens`) | yes |
| **Semantic cache** | embedding similarity of the prompt (Redis + Qdrant) | **No — any request carrying `tools` bypasses it by design** (determinism) |

Practical consequence for agents: **tool-calling turns are effectively
uncached** — expect real cost/latency and `source: "llm"` in traces (SPEC §14).
This is expected, not a defect. The exact cache still applies semantics on the
*prompt*, so an identical replay lands fast.

## M1 finding: exact-cache replay speed

An identical prompt replayed in **~15–30 ms**, served from cache even when the
second call used a different `max_tokens` — keying appears to be model + user
text only. Two operational consequences:

- Re-running the same user message is nearly free — useful for eval replays.
- If you *intended* varied `max_tokens` to randomize a response, it won't; the
  replay is the same cached completion.

## `cache_info` and `X-Cache`

Every completion can carry `cache_info` (`source`, `score`, `cache_hit`,
`intent`, `exact_hash`, `latency_breakdown`), plus an `X-Cache` response
header. The harness surfaces both per LLM call:

- `ChatResponse.cacheInfo` — verbatim gateway payload (typed `unknown` on
  purpose: core stays gateway-agnostic).
- `ChatResponse.xCache` — the header string, if present.
- `RunEvent.llm_call.cacheInfo` — recorded onto the event stream (M2/M3 will
  persist + analyze it; see [analytics.md](./analytics.md)).

### `source` values you'll see

| `source` | Meaning |
| --- | --- |
| `sem` (semantic) | Served from the semantic cache |
| `exact` | Served from the exact cache |
| `llm` | Real provider call — the expected value for any tool turn |

## `session_id` — cache scope binding

Setting `AGENT_SESSION_ID` sends `session_id` in the body, scoping cache
entries to that session. Leave it empty for fully shared caches; set it when an
agent's prompts are session-local and you don't want cross-pollination.

## `exact_hash` — the durable trace join

`cache_info.exact_hash` identifies the trace row for the prompt. Because the
gateway (as of M1) does **not** persist `X-Request-ID` on `/gateway-requests`
rows, this is the *only* reliable way to fetch the server-side trace later:

```
RunEvent.llm_call.cacheInfo.exact_hash
  → GET /api/v1/gateway-requests/by-hash/{hash}
```

`get_trace_by_hash` in the planned M2 toolset exposes this. See
[ADR 0002](./adr/0002-run-id-request-id-correlation.md) for why request IDs
alone can't do it.

## Cache-quality issues (v1 capability, tools land in M2)

The gateway evaluates cache quality; suspect entries can be found via
`evaluation_status=FAILED`, `is_false_positive=true`, or low relevance/
entailment scores. Echo Ops's "cache-quality audit" capability summarizes
those and flags thresholds to review. Until the tools ship, audit against the
API directly or via `list_traces`.

## Anti-patterns

- Assuming a tool turn is cached (it isn't — semantic-wise) and caching tool
  *results* in logs as if they were LLM-served.
- Building prompts to *fool* the exact cache (e.g. appending whitespace)
  instead of using `session_id` scoping or prompt hygiene — the cache is a
  feature, not an obstacle.
- Treating `cache_info` as stable contract: it is gateway-shaped and may grow —
  capture verbatim, parse defensively at the point of use.
