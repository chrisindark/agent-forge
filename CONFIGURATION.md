# Configuration

`loadConfig()` (in `src/core/config.ts`) reads an env-like record (defaults to
`process.env`), validates everything with zod, applies defaults, and throws a
`ConfigError` listing **every** invalid field at once. Secrets come from the
environment or a local `.env` — never committed (`.env.example` is the committed
template). See [SECURITY.md](./SECURITY.md) for secret handling.

## Variables (SPEC §10)

| Variable | Default | Required | Meaning |
| --- | --- | --- | --- |
| `GATEWAY_URL` | `http://localhost:8000` | no | Echo Gate base URL. Trailing slashes are normalized away. |
| `GATEWAY_API_KEY` | — | **yes** | Tenant API key (`eg_…`), sent as `X-API-Key`. Missing/empty → `ConfigError`. |
| `AGENT_PROVIDER` | `groq` | no | `service_name` in the chat body (gateway-specific, injected as `extraBody`). |
| `AGENT_MODEL` | `openai/gpt-oss-20b` | no | Requested model. Only allowlisted models are valid per provider (SPEC §14). |
| `AGENT_TENANT_ID` | — | no | **Deliberately unused in M0/M1** — the API key already establishes tenant identity; sending it would *override* the key (see [docs/authentication.md](./docs/authentication.md)). |
| `AGENT_USER_ID` | `ops-agent` | no | Same override caveat. |
| `AGENT_SESSION_ID` | — | no | Optional; binds a cache scope and is sent as `session_id` when non-empty. |
| `MAX_STEPS` | `8` | no | Hard cap on agent-loop iterations. |
| `TEMPERATURE` | `0.2` | no | Sampling temperature, clamped to `0.0–2.0`. |
| `MAX_TOKENS` | `1024` | no | Per-call completion cap. Note the reasoning-model trap in [docs/token-accounting.md](./docs/token-accounting.md). |
| `TOOL_TIMEOUT_MS` | `10000` | no | Default per-tool timeout; per-`ToolDef.timeoutMs` overrides. |
| `RUN_BUDGET_TOKENS` | `50000` | no | Optional hard stop on cumulative tokens across the run. |

Numbers are coerced defensively (`z.coerce.number()`), integers where integral
(`MAX_STEPS`, `MAX_TOKENS`, `TOOL_TIMEOUT_MS` must be positive), and out-of-range
values (e.g. `TEMPERATURE`) surface as named field errors in the `ConfigError`.

## Validation behavior

Successful load returns an `AppConfig` with `GATEWAY_URL` normalized (no
trailing `/+`). On failure you get one aggregated message, for example:

```
ConfigError: Invalid configuration:
  - GATEWAY_API_KEY: Required
  - TEMPERATURE: Number must be less than or equal to 2
```

## Precedence

1. Explicit record passed to `loadConfig(env)` (used by smoke/tests to inject
   values without touching the environment)
2. `process.env`
3. Local `.env` (loaded by `import "dotenv/config"` in `smoke.ts`; tests set
   values explicitly instead)
4. Schema defaults

## `.env.example` (committed template)

```
# Provided in .env.example; keep real secrets only in .env
GATEWAY_URL=http://localhost:8000
GATEWAY_API_KEY=
AGENT_PROVIDER=groq
AGENT_MODEL=openai/gpt-oss-20b
AGENT_TENANT_ID=
AGENT_USER_ID=ops-agent
AGENT_SESSION_ID=
MAX_STEPS=8
TEMPERATURE=0.2
MAX_TOKENS=1024
TOOL_TIMEOUT_MS=10000
RUN_BUDGET_TOKENS=50000
```

## Values that are *code*, not config

These live in `AgentLoopOptions`/client options rather than env vars (add a
variable only when a change without redeploy is genuinely needed):

- LLM call timeout: `120_000` ms default in `LlmClient` — deliberately far above
  the gateway's 15 s provider timeout because a tool turn chains provider calls
  (SPEC §14). `GatewayClient` standalone default is `30_000`.
- Tool executors default `TOOL_TIMEOUT_MS` from config (`10_000`).
- `budgetTokens = RUN_BUDGET_TOKENS`; `maxSteps = MAX_STEPS`.
- `tool_choice` is always `"auto"` in the loop (overrides are a future need).
