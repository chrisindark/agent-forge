# Contributing

Thanks for considering a change to agent-forge. This repo is rebuilt around a
documentation-first structure — keep code and docs moving together.

## Quick start

```bash
npm install
npm test     # 44 hermetic tests; no gateway needed
```

## Before you open a PR

**All three gates green:**

```bash
npm run typecheck   # tsc, noEmit, strict + noUncheckedIndexedAccess + more
npm test            # vitest, hermetic only
npm run build       # dist/ ESM + declarations must keep compiling
```

**Docs updated together with behavior:**

- New/changed env vars → [CONFIGURATION.md](./CONFIGURATION.md) table + `.env.example`.
- Public API changes (anything exported from `src/index.ts`) →
  [API_REFERENCE.md](./API_REFERENCE.md).
- New architectural decision → an ADR under [docs/adr/](./docs/adr/) (see the
  existing three as templates).
- Error behavior changes → [docs/troubleshooting.md](./docs/troubleshooting.md)
  taxonomy table.
- Anything touching the loop/tool contract → [ARCHITECTURE.md](./ARCHITECTURE.md)
  and the relevant invariants.

## Conventions that will be enforced in review

1. **ESM relative imports end in `.js`** even inside `.ts` files (ADR 0001;
   a compile error otherwise — see [DEVELOPMENT.md](./DEVELOPMENT.md)).
2. **`core/` stays gateway-agnostic.** No `cache_info`-shaped fields, no
   `service_name`, no allowlist knowledge inside `core/`. Gateway specifics ride
   as `extraBody`/options in `agents/`/`tools/gateway/`.
3. **`ToolExecutor.run` never throws** (ADR 0003). New failure modes are new
   `ToolErrorCode`s. Preserving this contract is the single most important
   review rule in the repo.
4. **Loop invariants** (SPEC §7): assistant messages preserve `tool_calls`; tool
   messages carry `tool_call_id`.
5. **Tests are hermetic.** No test performs real network I/O. Inject
   `fetchImpl`/`LlmLike` fakes; live behavior belongs to `npm run smoke`.
6. **File headers** follow the existing JSDoc convention, tying a module to
   its original SPEC/PLANS section (see the provenance map in
   ARCHITECTURE.md — the source docs were consolidated 2026-10-20). Keep
   cross-references accurate.
7. Don't touch `.env`; upgrades to `.env.example` are fine (no real secrets).

## Commits & PRs

- Commit messages: short imperative summary; body explaining *why* when non-obvious
  (`fix: honor Retry-After in gateway backoff`, `docs: ADR for run/request IDs`).
- One logical change per PR. Link the milestone it advances (M0–M5) from
  [ROADMAP.md](./ROADMAP.md).
- Include test counts in the PR description if tests were added/removed
  ("expects 44 → 47").

## Adding a tool (M0–M2 pattern)

See `src/tools/gateway/health.ts` as the minimal template:

1. Define a `ToolDef` (name, description, zod `schema`, handler).
2. Derive `parameters` from the schema — only override when the model-facing
   schema must differ from the validation schema.
3. Marshal HTTP details inside the handler; treat the response as data.
4. Register through the agent's `createEchoOpsTools` wiring — not by importing
   into `core/`.
5. Add an executor test covering the success path *and* at least one structured
   error outcome.
