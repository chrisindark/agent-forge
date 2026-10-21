# ADR 0003 — Tool executor never throws

- **Status:** accepted
- **Date:** 2026-10-18 (M0) / documented 2026-10-20
- **Scope:** tool execution failure handling and the agent loop contract
- **Context code:** `ToolExecutor.run` / `classifyThrown` (`core/tools/executor.ts`),
  `toToolMessage` (same file), "tool errors self-correct" rule in
  `agent-loop.ts` header comment

## Context

An LLM's tool call is un-trusted input to a **normal function** that can fail
in a dozen ways: unknown name, malformed JSON args, schema-arg mismatches,
timeouts, aborts, plain handler bugs. The obvious implementation (`try { run }
catch { abort run }`) makes every failure a *run* failure — that trains the
agent to treat its own environment as fragile, and makes timeouts/wrong-args
indistinguishable to the caller.

SPEC §7 states the intended behavior instead: *"Tool errors are returned as
tool-result content (`{ok:false,error}`) so the model can self-correct instead
of aborting the run."* That is also what agent loop test suites assert
(`tests/agent-loop.test.ts` — error outcomes are pushed as tool messages and
the loop continues).

## Decision

**`ToolExecutor.run(call, ctx)` never throws** — for any input, any handler
behavior, any environment failure. Every failure mode becomes a structured:

```ts
interface ToolOutcome {
  ok: false,
  error: { code: ToolErrorCode, message: string },
}
```

with a closed code set:

| code | failure mode |
| --- | --- |
| `unknown_tool` | name not in registry |
| `invalid_json` | `arguments` blob not parseable |
| `invalid_arguments` | zod validation failed |
| `timeout` | per-tool/executor deadline fired (`ToolTimeoutError`) |
| `aborted` | context `AbortSignal` fired (cancellation is not an error) |
| `tool_error` | handler threw anything else |

`toToolMessage(outcome)` then wraps outcomes as content the *model* reads:
`{ok:true, result}` / `{ok:false, error}` — including the error code, so the
model can distinguish "I sent bad arguments" (retry with different args) from
"the tool is broken" (give up / report back) from "it timed out" (try
something lighter or report the timeout).

Duration handling (`durationMs`) is always present, instead of being
silently omitted on failure paths — a debugging surface, not just a metric.

## Failure → outcome → message flow

```
LLM: tool_call { id, function: {name, arguments: "…"} }
  → ToolExecutor.run
      unknown name?   → unknown_tool        (message: unknown tool name)
      unparseable?    → invalid_json        (keep parse error message)
      schema fails?   → invalid_arguments   (zod verbose issues, flattened)
      race timeout?   → timeout             (loser of Promise.race)
      signal aborts?  → aborted
      handler throws? → tool_error          (error.message preserved)
  → toToolMessage → { role:"tool", tool_call_id, content: json({ok:false, error}) }
  → pushed into transcript → next chat() sees the failure + can react
```

## Alternatives considered

- **Throw from `run`, catch in the loop.** Rejected: turns "tool failed" into a
  loop concern, forcing every loop integration (ours, evals, the future NestJS
  server, MCP adapter) to reimplement recovery identically. The executor owns
  the semantics; consumers own transport.
- **`Either`/`Result` type instead of `{ok, error}` unions.** Rejected: heavier
  types, no behavior change — the shape here doubles as the wire payload the
  model reads, which a dedicated `Result<A, E>` would not.
- **Abort on `tool_error` (user-visible failures only).** Rejected after
  noticing the loop contract from SPEC §7 is *does not* abort — the model's
  tool-call choice is what we evaluate, not whether the implementation is
  bug-free (deterministic boundaries, SPEC §1).

## Consequences

**Positive:**

- New failure modes = new `ToolErrorCode` + test, not new throw-sites — a
  closed, reviewable contract.
- Empowers the harness's hard requirement (model self-correction) instead of
  the harness papering over failures.
- Cancel is explicit (`aborted`) and must never be confused with failure in
  eval/audit logic.

**Negative / costs:**

- The never-throws contract is invoked by callers; a caller that "upgrades" an
  outcome to a throw (or forgets the shape) reintroduces inconsistency —
  AGENTS.md hard rule 3 exists to prevent exactly that drift.
- Handlers that throw deliberately to *signal* (assert-style) lose the
  distinction — express that as an `ok:false, error:{code:"tool_error",
  message}` result instead. Deliberate throwing-as-API is an anti-pattern
  here.
