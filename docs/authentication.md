# Authentication

How the harness identifies itself to Echo Gate, and how identity is scoped.

## The one authenticator: `X-API-Key`

`GatewayClient` sends `X-API-Key: <GATEWAY_API_KEY>` on **every** request
(chat completions, health checks). The gateway resolves the key → tenant +
user and applies Postgres RLS. All trace/analytics reads are tenant-scoped by
the server: the agent sees only its own tenant's rows (SPEC §14).

- Key format: `eg_...` (tenant-scoped key from `POST /api/v1/admin/api-keys/`).
- The **admin key** (`agent-forge-m1` with `admin:*`) was used only to mint the
  tenant key during provisioning; it must never be set as `GATEWAY_API_KEY`.
- Missing/empty key is a `ConfigError` at load time — fail closed, no run
  starts.

## The body-identity override trap (M1 finding — important)

Echo Gate lets the chat body carry `tenant_id` / `user_id`, and **those fields
override the API-key identity** (body wins). The harness deliberately never
sends them:

- `LlmClient` builds the body from `ChatRequest` only — identity injection
  would happen via `extraBody`, and the Echo Ops wiring sets only
  `service_name` and (optionally) `session_id`.
- The committed env vars `AGENT_TENANT_ID` / `AGENT_USER_ID` exist for future
  use but are intentionally unused in M0/M1 (see
  [CONFIGURATION.md](../CONFIGURATION.md)).

Unless you consciously want an identity override *and* the server side
authorizes it, do not route tenant identity through the body. Keep RLS with the
key as the authority.

## Sessions (identity-adjacent)

`AGENT_SESSION_ID` is not authentication — it binds a cache scope and is sent
as `session_id` in the body when non-empty. See
[caching.md](./caching.md).

## Request identifiers are not credentials (ADR 0002)

- The harness mints per-call `X-Request-ID` (`af-<uuid>`) for correlation with
  gateway logs — **not** for authorization.
- The LB/gateway may replace a client-supplied request ID; treat the echoed
  value as advisory until verified.
- A caller-supplied request ID must never grant trace access: `get_trace` /
  `list_traces` rely on server-side RLS, not on knowing a recognizable ID.

## Provisioning recall (steps that worked in M1)

1. Mint admin key in the echo-gate repo (or reuse an existing one).
2. `POST /api/v1/admin/api-keys/` → tenant + user → save to `.env`.
3. Raise quota for the tenant/provider/model (default is 10 RPM / 20 000 TPM;
   M1 rule 131 set 60 RPM / 200 000 TPM) — quota is `min()` across matching
   rules. See [rate-limiting.md](./rate-limiting.md).

## Health checks unauthenticated?

No — `X-API-Key` is sent on health probes too; a `401` there surfaces as a
`GatewayError{kind:"auth"}` on the check result (`ok:false`) rather than a run
failure, because `health()` never throws.
