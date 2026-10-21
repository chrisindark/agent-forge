# agent-forge

Agent Forge is an agent framework with a built-in execution harness, written in
TypeScript for Node 20+. It runs agents against any OpenAI-compatible LLM
endpoint, using **Echo Gate** (`http://localhost:8000`) as the reference
gateway.

**Status: M0 + M1 complete** — config, tool system, gateway client, LLM client,
agent loop, and the first read-only agent (Echo Ops). A real tool-call round
trip through Groq via Echo Gate was verified 2026-10-18. See
[ROADMAP.md](./ROADMAP.md).

## What it gives you

Three layers plus an entry point:

| Layer | Verb | Owns |
| --- | --- | --- |
| **Agent** (definition) | Create | Identity, instructions/objectives, model + generation settings, tool declarations & permissions, memory/knowledge config, reusable definitions |
| **AgentRuntime** | Execute | Reasoning/action loop, LLM requests through Echo Gate, tool execution & result handling, context assembly, stop conditions / iteration limits / timeouts |
| **AgentHarness** | Control | Tool permission enforcement, budgets, tracing/events/audit logs, retries & failure handling, fixtures, evaluations, reproducibility |
| **AgentRunner** | — | Public entry point that brings them together |

Guiding principles:

- **Harness first, agents second.** The runtime is provider-agnostic; Echo Gate
  is just the first target, with its niceties (`cache_info`, `service_name`)
  isolated in an adapter layer.
- **Read-only before mutating.** The first agent only reads. Mutating tools come
  later behind an approval gate.
- **Deterministic tool boundaries, probabilistic reasoning.** Tool schemas and
  outputs are strictly typed; the model's tool choice is what we evaluate.

## Quickstart

```bash
npm install

cp .env.example .env        # then set GATEWAY_API_KEY
npm test                    # 44 hermetic tests — no gateway needed
npm run smoke               # live single-turn probe; needs a running gateway
```

Set `GATEWAY_URL` / `GATEWAY_API_KEY` (and adjust `GATEWAY_API_KEY` provisioning
per [docs/getting-started.md](./docs/getting-started.md)). Full variable
reference: [CONFIGURATION.md](./CONFIGURATION.md).

## Repository layout

```
src/
  core/            provider-agnostic runtime (types, config, loop, tools, errors)
    gateway/       typed HTTP client (transport adapter)
    tools/         registry + executor
    llm-client.ts  OpenAI-compatible chat client
    agent-loop.ts  the tool-calling loop
  agents/echo-ops/ first agent: prompt + tool binding + wiring
  tools/gateway/   Echo Ops toolset (grows per milestone)
tests/             hermetic vitest suites (mock fetch / fake LLM)
docs/              topical documentation + ADRs
examples/          runnable examples (in progress)
```

## Documentation

| Document | Purpose |
| --- | --- |
| [ROADMAP.md](./ROADMAP.md) | Milestones M0–M5, status, open questions |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Layers, module responsibilities, identifier model, invariants |
| [CONFIGURATION.md](./CONFIGURATION.md) | Every environment variable, defaults, precedence |
| [DEVELOPMENT.md](./DEVELOPMENT.md) | Setup, scripts, ESM conventions, testing approach |
| [API_REFERENCE.md](./API_REFERENCE.md) | Public surface exported from `src/index.ts` |
| [SECURITY.md](./SECURITY.md) | Secrets, trust boundaries, tenant scoping, planned gates |
| [RELEASES.md](./RELEASES.md) | Versioning, release process, publish checklist |
| [CONTRIBUTING.md](./CONTRIBUTING.md) | How to change this repo |
| [AGENTS.md](./AGENTS.md) | Working rules for AI coding agents in this repo |
| [CHANGELOG.md](./CHANGELOG.md) | Notable changes per version |
| [docs/getting-started.md](./docs/getting-started.md) | Install → configure → first run |
| [docs/concepts.md](./docs/concepts.md) | Runs, steps, tools, budgets, stop conditions |
| [docs/authentication.md](./docs/authentication.md) | API keys, tenants, RLS, identity gotchas |
| [docs/caching.md](./docs/caching.md) | Exact/semantic cache, `cache_info`, tool-turn bypass |
| [docs/token-accounting.md](./docs/token-accounting.md) | Usage tracking, budgets, reasoning-model traps |
| [docs/rate-limiting.md](./docs/rate-limiting.md) | Quota rules, 429s, Retry-After, timeouts |
| [docs/analytics.md](./docs/analytics.md) | Gateway analytics + run records (M3) |
| [docs/deployment.md](./docs/deployment.md) | Runtime requirements, build output, operational prereqs |
| [docs/troubleshooting.md](./docs/troubleshooting.md) | Error taxonomy and known failure modes |
| [docs/faq.md](./docs/faq.md) | Short answers to recurring design questions |
| [docs/adr/](./docs/adr/) | Architecture decision records |
| [examples/](./examples/README.md) | Runnable examples index |

## License

[MIT](./LICENSE)
