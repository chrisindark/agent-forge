# Token Accounting

Where usage is tracked, how budgets are enforced, and the reasoning-model trap.

## Usage shape

```ts
interface TokenUsage { prompt_tokens: number; completion_tokens: number; total_tokens: number }
```

Per LLM call: `ChatResponse.usage` (gateway-reported; zeroed safely when
absent via `normalizeUsage`).

## Accumulation across a run

`runAgent` starts from `emptyUsage()` and folds each call's usage with
`addUsage(usage, resp.usage)` after every `chat()`:

- `AgentResult.usage` = cumulative over the whole run.
- `RunEvent.llm_call.usage` = per call.
- `RunEvent.run_finished.usage` = cumulative at stop time (record also carries
  `steps` and, on failure, `error`).

The helpers' safety property: if the loop aborts mid-step, accounting reflects
exactly the calls that completed.

## Budgets

| Control | Default | Enforced at |
| --- | --- | --- |
| `RUN_BUDGET_TOKENS` (budgetTokens) | `50_000` | after each step: `usage.total_tokens > budgetTokens` → failed result (`Token budget exceeded after step N`); the step that crossed still completes |
| `MAX_TOKENS` | `1024` | per call, sent to the gateway |
| `MAX_STEPS` | `8` | loop bound; "MAX_STEPS exceeded without a final answer" |
| `TOOL_TIMEOUT_MS` | `10_000` | per tool inside `ToolExecutor` (missing deadline ⇒ `timeout` outcome) |

Cost accounting (USD) is **not** yet implemented — it needs the gateway's
pricing (`POST /api/v1/llm-usage/calculate-costs`) and is part of M3's tracer.
Today usage is tokens only; [analytics.md](./analytics.md) tracks the plan.

## The reasoning-model trap (M1 finding)

`openai/gpt-oss-20b` emits `reasoning_content`. Two consequences:

1. **It consumes `max_tokens`.** A reasoning-heavy generation can exhaust
   `MAX_TOKENS` *before* producing user-visible output: you get
   `content: ""` with `finish_reason: "length"` while tokens were still spent
   — a budget can silently zero out the answer.
2. **The harness drops it from the transcript** (`normalizeMessage`), keeping
   `Message` OpenAI-shaped — reasoning isn't echoed back in later turns.

Countermeasures when you see empty content:

- Raise `MAX_TOKENS` (watch the exact-cache interplay: identical prompts with
  different `max_tokens` replay from cache at the *original* completion — see
  [caching.md](./caching.md)).
- Prefer a cheaper-model/route bubble: read the *effective* model off
  `ChatResponse.model` (fallback may differ from `requestedModel`).

## Why tokens, not requests

Slow thinking burns far more tokens than throughput. Budgeting on steps alone
lets one turn of a reasoning model blow the run's spend; budgeting on requests
alone allows a runaway per-request `max_tokens`. Hence both `MAX_STEPS` *and*
`RUN_BUDGET_TOKENS`.

## Design note: usage recorded per call, not per second

Per-call usage (what the gateway reports) is retained, not inter-posed with
estimates. Estimates are an M3 evaluation feature (cost windows, projection);
until then every reported number traces to one `usage` field from one API
response.
