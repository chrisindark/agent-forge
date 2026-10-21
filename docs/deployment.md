# Deployment

Where the harness runs, what it needs, and what must be provisioned on Echo
Gate before pointing it somewhere real.

## Runtime requirements

| Requirement | Why |
| --- | --- |
| Node ≥ 20 | `engines` constraint; global `fetch`, `AbortController` semantics, ESM. Node 22.23 is the tested version (`v22.23.2`). |
| ESM consumer | `dist/` is `"type": "module"` — no CJS build on purpose (ADR 0001). CJS consumers need Node ≥ 22 `require(esm)` or dynamic `import()`. |
| No external DB/queue | The harness is stateless; run records are the only persistence (M3 JSONL) — write them wherever your runtime can write files. |

## Building and embedding

```bash
npm run build            # → dist/ (ESM JS + .d.ts + sourcemaps)
```

From another package: consume the built surface via `dist/index.js` +
`dist/index.d.ts` (`main`/`types` are already wired), or run primitives
(`runAgent`, `LlmClient`, …) directly.

Local probe without anyone else installing the package:

```bash
npm run smoke            # live single-turn probe; requires running gateway
```

## Operating prerequisites on Echo Gate (SPEC §14)

Before pointing a real agent environment at a gateway:

1. **API key**: tenant-scoped key via `POST /api/v1/admin/api-keys/` →
   `GATEWAY_API_KEY` in that environment's secret store. Never the admin key.
2. **Quota rule**: default 10 RPM / 20 000 TPM will throttle any multi-step
   loop. Provision a rule per tenant/provider/model (M1: 60 RPM / 200 000 TPM
   for `acme` × `groq` × `openai/gpt-oss-20b`). Quota is `min()` across all
   matching rules — verify, don't assume; see [rate-limiting.md](./rate-limiting.md).
3. **Model allowlist**: `openai/gpt-oss-20b` (and `-safeguard-20b`) on `groq`.
   A fallback provider can silently switch the effective model — the harness
   reads `response.model` back rather than trusting the request (see
   [token-accounting.md](./token-accounting.md)).
4. **Timeouts**: keep client LLM timeouts well above the gateway's
   `LLM_PROVIDER_TIMEOUT_SECONDS` (15 s) — a tool turn can chain provider
   calls. Default `LlmClient` timeout is 120 s for this reason.
5. **Tenant scoping awareness**: analytics/trace reads are RLS-scoped to the
   key's tenant; elevated access requires the gateway's trusted-header
   mechanism (open question, SPEC §16.3) — not implemented here.

## Environment shape

```ini
GATEWAY_URL=https://<gateway-host>     # prod: real host, not localhost
GATEWAY_API_KEY=<tenant key>           # secret manager → env injection
AGENT_PROVIDER=<provider>              # e.g. groq
AGENT_MODEL=<allowlisted model>
MAX_STEPS=8
TEMPERATURE=0.2
MAX_TOKENS=1024
TOOL_TIMEOUT_MS=10000
RUN_BUDGET_TOKENS=50000
AGENT_SESSION_ID=                     # optional; binds a cache scope
```

The `.env` file is a local convenience (`dotenv` in `smoke.ts`); in
deployment inject real env vars via your process manager/secret store.
Never bake secrets into images.

## Sizing guidance

- Runs are step-serial (one LLM call at a time, tools in sequential per-step
  order). Concurrency across **runs** is fine and scales with your event
  loop; parallelism *within* a run (parallel tool execution) is a M2+ topic.
- Worst-case wall time per step ≈ gateway timeout (120 s default), so
  `MAX_STEPS × step_time` bounds a run. Tune `MAX_STEPS` + `budgetTokens`
  together rather than letting either go unbounded.

## Known ops pitfalls (from M1)

- Empty `content` + `finish_reason: "length"` on reasoning models — see
  [troubleshooting.md](./troubleshooting.md#empty-content-with-finish_reason-length).
- `tenant_id`/`user_id` in the chat body would override key identity — the
  harness omits them on purpose; keep your own integrations consistent.
- Request IDs are for log correlation, not trace lookup (see ADR 0002).
