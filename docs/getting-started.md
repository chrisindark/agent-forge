# Getting Started

End-to-end path from clone to a working agent run. For variable semantics see
[CONFIGURATION.md](../CONFIGURATION.md); what happens at runtime:
[concepts.md](./concepts.md).

## 1. Prerequisites

- **Node ≥ 20** (the harness is ESM and uses built-in `fetch`/`AbortController`).
- A running **Echo Gate** instance for live runs (`npm run smoke` and the
  agent's LLM calls). Everything else — typecheck, build, the whole test suite
  — is hermetic and needs no gateway.

## 2. Install

```bash
npm install
```

## 3. Configure the environment

```bash
cp .env.example .env
```

Minimum for a live run:

```ini
GATEWAY_URL=http://localhost:8000
GATEWAY_API_KEY=eg_...        # tenant-scoped key, NOT the admin key
```

Optionally tune `AGENT_PROVIDER`, `AGENT_MODEL`, `MAX_STEPS`, budgets — see
[CONFIGURATION.md](../CONFIGURATION.md) for the full table and defaults.

## 4. Verify the toolchain without the gateway

```bash
npm run typecheck   # tsc clean over src+tests
npm test            # 44 hermetic tests (mock fetch / fake LLM)
npm run build       # dist/ ESM + declarations
```

## 5. Provision against Echo Gate (live path)

Steps actually performed for M1 (record of what worked):

1. **Admin key** — minted in the echo-gate repo:
   ```bash
   python -m app.scripts.create_admin_key create --name agent-forge-m1 --scopes 'admin:*'
   ```
2. **Tenant API key** — via admin API:
   `POST /api/v1/admin/api-keys/` → tenant `acme`, user `ops-agent` → put it in
   `GATEWAY_API_KEY`.
3. **Raise the quota rule** — the default is 10 RPM / 20 000 TPM, which a
   multi-step loop will trip. Rule from M1: tenant `acme` / provider `groq` /
   model `openai/gpt-oss-20b` → **60 RPM / 200 000 TPM**.

   ⚠️ Quota semantics are `min()` across **all matching rules** — verify which
   rules exist for your tenant before assuming a raised limit applies
   (see [rate-limiting.md](./rate-limiting.md)).

## 6. Smoke-test against the gateway

```bash
npm run smoke
```

Single-turn completion + `gateway_health` round trip Expected results:

- **Gateway up + valid key**: health check JSON and one completion logged.
- **Gateway down / unreachable**: `GatewayError` with `kind:"network"`,
  `status:0` and a clear hint — this is expected while Echo Gate isn't running
  locally (see [troubleshooting.md](./troubleshooting.md)).

## 7. Run (and embed) the first agent

```ts
import "dotenv/config";
import { createEchoOpsAgent, loadConfig } from "./src/index.js"; // or "agent-forge" once published

const agent = createEchoOpsAgent({ config: loadConfig() });

const events: unknown[] = [];
const result = await agent.run("Is the gateway healthy right now?", {
  onEvent: (e) => events.push(e), // RunEvent stream (richer tracing in M3)
});
console.log(result.ok, result.content, result.usage);
```

Or drive the composed pieces directly with an `LlmClient` + custom
`ToolRegistry` + `runAgent` (full example: [API_REFERENCE.md](../API_REFERENCE.md)).

## 8. Next steps

- Author a new tool: [CONTRIBUTING.md](../CONTRIBUTING.md) ("Adding a tool") +
  `src/tools/gateway/health.ts` as the template.
- Understand run/steps/budgets/stop conditions:
  [concepts.md](./concepts.md).
- What the harness depends on from Echo Gate, and where its constraints shape
  behavior (no streaming, tool-turns uncached, effective model read-back):
  [caching.md](./caching.md) and
  [token-accounting.md](./token-accounting.md).
