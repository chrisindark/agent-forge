# Rate Limiting

How the harness behaves under quota pressure and around timeouts. Error
taxonomy reference: [troubleshooting.md](./troubleshooting.md).

## Quota rules on the gateway side

- Default: **10 RPM / 20 000 TPM** per tenant/provider/model — far below what a
  multi-step agent loop needs. Raise a rule *before* looping.
- Quota is `min()` across **all matching rules** — an old narrow rule on a
  broad scope will silently bind you even after you add a generous one. The M1
  provisioning hit exactly this: a pre-existing 9-RPM rule scoped to tenant
  `dev` did *not* bind `acme`, but that was luck of scoping; verify rules
  rather than assume a single matching row.
- Effective limits for the M0/M1 setup (rule 131): tenant `acme`, provider
  `groq`, model `openai/gpt-oss-20b` → **60 RPM / 200 000 TPM**.
- Exceeding RPM/TPM → `429`. Prepaid budget exhausted → `402`.

## Harness behavior per status (SPEC §11)

| Status | Meaning | Harness behavior |
| --- | --- | --- |
| `401`/`403` | Missing/invalid key | `GatewayError{kind:"auth"}`, `.fatal === true` — fail fast |
| `429` | RPM/TPM exceeded | `kind:"quota"`; `retryAfterMs` parsed from `Retry-After` (seconds or HTTP-date); conservative backoff — the gateway already retries + falls back internally, the harness backs off rather than double-retrying aggressively |
| `402` | Prepaid budget exhausted | `kind:"budget"`, fatal — stop the run |
| `400`/`422` | Validation / model not in allowlist | `kind:"validation"`, fatal — surface the server `detail` |
| `503` | Provider *and* fallback failed | `kind:"unavailable"` — backoff, then abort the run |
| other 5xx | transient | `kind:"transient"` — limited retries with jitter |

`parseRetryAfterMs` handles both forms; the parsed ms are exposed on the error
for M1's client-level retry policy and M5's full backoff implementation.

## Timeouts stack at three levels

| Layer | Who enforces | Default | Notes |
| --- | --- | --- | --- |
| LLM call | `LlmClient` (via `GatewayClient.requestDetailed`) | **120 s** | deliberately ≥ the gateway's 15 s provider timeout — a tool turn can chain provider calls (SPEC §14). Firing earlier would abort legitimate calls. |
| Generic gateway request | `GatewayClient` | 30 s | health checks, (future) trace/tool HTTP calls |
| Tool execution | `ToolExecutor` (withTimeout race) | `TOOL_TIMEOUT_MS` = 10 s | per-tool `ToolDef.timeoutMs` override; produces `timeout` outcome, never throws |

Abort cooperation is real plumbing, not decoration: an `AbortSignal` cancels
between loop steps, during LLM calls (HTTP abort), and inside tool executors
(`Promise.race` abort arm). See [concepts.md](./concepts.md) for the stop
order.

## Avoiding self-inflicted 429s

1. **Budget with RPM, not just tokens.** A step loop with `MAX_STEPS=8`
   at 10 RPM quota cannot complete in a minute — it will 429 by design.
2. **Don't parallelize runs against the same tenant key** without checking
   aggregate RPM.
3. **Treat `429` differently from other backoff** — quota errors mean the
   gateway is *throttling you deliberately*; aggressive jittered retries make
   it worse and can burn TPM on rejected calls.
4. **Keep the harness backoff conservative** — re-read (SPEC §11): the gateway
   already retries providers internally; your retry is a second layer and must
   not multiply pressure.

## Not yet implemented (honest)

Per-call automatic retry/backoff is **not** wired in LlmClient yet (the
classification, `fatal` logic, and Retry-After parsing are — see
`src/core/errors.ts`). Loop-level policy wraps M5 hardening. Until then, a 429
bubbles out of `chat()` as a `GatewayError` and a loop running with default
options surfaces it via `AgentResult.error`.
