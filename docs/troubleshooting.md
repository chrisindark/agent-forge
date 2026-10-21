# Troubleshooting

Error taxonomy, known failure modes, and the diagnosis path for each. The
authoritative types live in `src/core/errors.ts` (`GatewayError`),
`src/core/config.ts` (`ConfigError`), and `src/core/tools/executor.ts`
(`ToolOutcome`).

## Load-time: `ConfigError`

Aggregates **every** invalid field at once — fix all lines, not just the
first:

```
ConfigError: Invalid configuration:
  - GATEWAY_API_KEY: Required
  - TEMPERATURE: Number must be less than or equal to 2
```

| Message | Fix |
| --- | --- |
| `GATEWAY_API_KEY: Required` | key missed in env / `.env` not loaded |
| `MAX_STEPS: ... positive` / `MAX_TOKENS: ...` | integers > 0 required (`z.coerce.number` accepts strings, e.g. `"8"` works) |
| `TEMPERATURE: ... less than or equal to 2` | clamp to 0.0–2.0 |

## Runtime: `GatewayError` taxonomy

| `kind` | Status | `.fatal` | Meaning / what to do |
| --- | --- | --- | --- |
| `auth` | 401/403 | yes | Bad or admin-instead-of-tenant key. Fix the key; don't retry. |
| `budget` | 402 | yes | Prepaid budget exhausted on the gateway. Top up / change billing. |
| `validation` | 400/422 | yes | Request malformed — usually a non-allowlisted model or bad `tools` payload. Read `error.detail` (body excerpt ≤ 2000 chars). |
| `quota` | 429 | no | RPM/TPM throttled. Honor `retryAfterMs`. See [rate-limiting.md](./rate-limiting.md) for quota-rule math (`min()` across rules). |
| `unavailable` | 503 | no | Provider **and** its fallback failed. Back off; check gateway/provider status. |
| `transient` | 5xx/timeout | no | Limited retries with jitter (loop-level policy in M5). |
| `network` | 0 | no | Connection failure — gateway down, wrong `GATEWAY_URL`, or local timeout fired (see below). |
| `unknown` | e.g. 200-parsed-bad | no | Wrapper error: e.g. response had no `choices[0].message`. Inspect `detail`. |

`GatewayError.detail` carries the response body excerpt (sliced to 2 000
chars) when a gateway response was received.

## Known failure modes and their diagnosis

### "Gateway request timed out after Nnnn ms" (via fetch abort → `kind:"network"`, `status:0`)

`GatewayClient` enforced its `timeoutMs` (`LlmClient` default **120 s**,
standalone default 30 s). A legit tool turn chains provider calls and can be
slow — this is why the LLM default is 4× the gateway's 15 s provider timeout.
If you see it *frequently*, your gateway is slow-degrading (check
`gateway_health`), not the harness misconfiguring time.

### `npm run smoke` exits 1 "Gateway unreachable"

Expected while Echo Gate isn't running locally — the probe is honest about a
missing dependency instead of pretending all is well. Start the
gateway, re-run. The 28-test hermetic suite never needs it.

### Empty `content` with `finish_reason: "length"`

The reasoning model (`openai/gpt-oss-20b`) spent your `MAX_TOKENS` on
`reasoning_content` (which the harness drops from the transcript) and didn't
reach an answer. Fix: raise `MAX_TOKENS`, or note the exact-cache interplay —
identical prompts with different `max_tokens` replay the *original* cached
completion ([caching.md](./caching.md)).

### `ToolOutcome.error.code` values

| Code | Meaning | Typical cause |
| --- | --- | --- |
| `unknown_tool` | model hallucinated a name | tool not registered / name drift; check `registry.get(name)` |
| `invalid_json` | `arguments` blob unparseable | model emitted malformed args — self-corrects via `{ok:false}` feedback |
| `invalid_arguments` | zod validation failed | schema drift between prompt description and `ToolDef.schema` |
| `timeout` | handler exceeded budget | slow handler / too-tight `TOOL_TIMEOUT_MS` |
| `aborted` | run's signal fired | caller cancelled or budget logic triggered abort |
| `tool_error` | handler threw | real handler bug — get the `message`, fix the tool |

Tool outcomes never throw; they arrive as messages the model can react to
(ADR 0003).

### Run finished `ok:false`, "Token budget exceeded after step N"

By design: budget checks happen per step ([token-accounting.md](./token-accounting.md)).
Raise `RUN_BUDGET_TOKENS` or lower `MAX_TOKENS`/`MAX_STEPS` — don't peg
budget at a huge value as a workaround, that's the spending guard.

### "MAX_STEPS (N) exceeded without a final answer"

The model kept calling tools (or echoing them without finishing). Typical
causes: tool failure loops (`tool_error` chains), a model being asked
something its tools can't do, or `MAX_STEPS` too low for the task shape.
Inspect `onEvent`'s `tool_call` events for the repeated pattern.

### Tool error causes run abort instead of self-correct

Won't happen by design — tool faults become `{ok:false,error}` content
(ADR 0003). If you see a run abort from a tool: the throw escaped the
executor's catch (path/exception class unknown to `classifyThrown`), which is
a bug worth filing rather than working around.

### Trace lookup by request ID returns nothing

`/gateway-requests` rows don't persist `X-Request-ID` (M1 finding). Join via
`cache_info.exact_hash` → `/gateway-requests/by-hash/{hash}` instead — the
planned `get_trace_by_hash` tool automates it. See [ADR 0002](./adr/0002-run-id-request-id-correlation.md)
and [analytics.md](./analytics.md).

## Escalation order

1. Check `npm run typecheck && npm test` — a stale build or drift reproduces as
   weird runtime shapes.
2. Run `gateway_health` (or hit `GET /api/v1/health/{ready,worker,celery}`
   directly) — degraded subsystems are the gateway's, not yours.
3. Read `GatewayError.detail` — the body excerpt usually names the actual
   server-side complaint.
4. Reproduce with a hermetic test (fake fetch returning the same
   status/body) before touching code.
