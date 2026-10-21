# ADR 0004 — Plain TypeScript core; NestJS reserved for the control plane

- **Status:** accepted
- **Date:** decision recorded in the original build plan (§9 "Framework decision"), consolidated 2026-10-20
- **Scope:** framework choice for the harness core vs future API surface

## Context

The product is defined in three layers (Create / Execute / Control) plus a
public entry point. The v0.1 deliverable is a **library + CLI**, not a web
service: `AgentRunner` is *imported*, tools are in-process functions, and the
interface is a `cli.ts` invocation. The question was whether to stand the core
up on **NestJS** (decorators, DI, HTTP bootstrap) or **plain TypeScript** with
zero framework dependencies.

## Decision

**Plain TypeScript for the core (M0–M5). NestJS is reserved for a later
`server/` control-plane layer that wraps `AgentRunner` when an observable,
controllable API is actually needed.**

Target layout backing this:

```
src/
  core/      # zero framework deps: types, config, llm-client, loop, registry, executor, tracer, errors
  tools/     # gateway adapter + Echo Ops tools (pure functions)
  agents/    # agent definitions (echo-ops first)
  cli.ts
server/      # (later) NestJS control plane wrapping core
tests/
```

## Rationale

- NestJS's HTTP/DI/module layer adds setup cost without serving anything the
  core needs today.
- The core must stay **transport-free** for two planned consumers:
  - the **MCP adapter** (tool interface designed to wrap over MCP), and
  - **hermetic eval fixtures** — calling `agent-loop` directly with no
    test-module bootstrap.
- The README's **Control** layer — dashboard, run APIs, approval gates for the
  v2 mutating tools, policy/audit DI — is where NestJS earns its keep. Adding
  it as a wrapper around `AgentRunner` means the runtime never has to know.

## Alternatives considered

- **NestJS from day one.** Rejected: the DI/module machinery solves problems
  the core doesn't have in 0.1 (no HTTP surface, in-process tools, few
  injectable policies beyond config), while its coupling makes "call the loop
  directly" harder than it should be.
- **A smaller HTTP framework (e.g. raw express) for the core.** Rejected for
  the same transport-coupling reason; the CLI doesn't need an HTTP server yet.

## Consequences

**Positive:** the core imports cleanly from CLI, tests, workers, notebooks,
and (later) `server/` with no framework locks; hermetic evals call functions,
not modules.

**Negative:** when the control plane ships it must wrap and re-expose runtime
capabilities it could have inherited — an integration cost accepted until the
API surface exists. If a policy-injection need grows large (approval gates,
audit sinks), revisit before reaching for a framework.
