# Development

## Requirements

- Node ≥ 20 (`engines.node` in `package.json`)
- npm 10+ (any npm that shipped with Node 20/22 is fine)

## Setup

```bash
npm install
cp .env.example .env      # set GATEWAY_API_KEY when you need live runs
npm test                  # hermetic; works with no gateway at all
```

## Scripts

| Command | What it does | Needs gateway? |
| --- | --- | --- |
| `npm run typecheck` | `tsc -p tsconfig.json` over `src`, `tests`, `vitest.config.ts` — type-only, `noEmit` | no |
| `npm test` | `vitest run` (7 files / 44 tests, hermetic) | no |
| `npm run test:watch` | vitest in watch mode | no |
| `npm run build` | `tsc -p tsconfig.build.json` → `dist/` (ESM JS + `.d.ts` + sourcemaps) | no |
| `npm run smoke` | `tsx src/smoke.ts` — live single-turn probe hitting a real gateway | **yes** |

All three gates (typecheck, test, build) must pass before any commit is
accepted — see [CONTRIBUTING.md](./CONTRIBUTING.md).

## Module format — read this first (ADR 0001)

This package is **ESM** (`"type": "module"`, `module`/`moduleResolution: NodeNext`).
Consequence: **relative imports use `.js` extensions even in `.ts` sources**:

```ts
// correct — everywhere in this repo
import { ToolRegistry } from "../src/core/tools/registry.js";
import type { ToolCall } from "./types.js";

// both of these are compile errors under NodeNext
import { ToolRegistry } from "../src/core/tools/registry";     // TS2835
import { ToolCall } from "./types.ts";                         // TS5097
```

Why that works: the emitted JS is at `dist/…` with the same relative layout, so
`…/registry.js` is simultaneously correct for Node at runtime **and** resolved
by tsc to `registry.ts` at typecheck time. TypeScript never rewrites import
specifiers, so the extension must be exactly what Node's ESM resolver needs.

Bare specifiers (`zod`, `vitest/config`, `node:crypto`) need no suffix — the
`.js` rule applies only to relative paths.

## Conventions

- **File headers**: every source file opens with a JSDoc block recording its
  purpose and the original `SPEC`/`PLANS` section it implements, e.g.
  `src/core/agent-loop.ts` ("The tool-calling agent loop (SPEC §7)").
  Preserve and update these comments when behavior changes. The original
  `SPEC.md`/`PLANS.md` were consolidated into this docs set on 2026-10-20;
  `SPEC §N` citations are historical provenance, with their section→document
  mapping in [ARCHITECTURE.md](./ARCHITECTURE.md) ("Document provenance").
- **Strict TS**: `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`,
  `noFallthroughCasesInSwitch` are on. Write to them; don't weaken flags.
- **Module boundaries** (see [ARCHITECTURE.md](./ARCHITECTURE.md)): `core/`
  never imports `agents/` or `tools/gateway/`; gateway-specific fields never
  enter `core/types.ts` (they ride as `extraBody`/options injected at wiring
  time).
- **`ToolExecutor.run` never throws** — failures become structured
  `ToolOutcome`s (ADR 0003). New failure modes need a `ToolErrorCode`, not a
  throw.
- **Backticks for code, actual TypeScript in examples.** Reference symbols with
  their file when the doc is non-obvious.

## Testing approach

- **Hermetic by construction.** No test performs network I/O. Egress is always
  injected: `fetchImpl?` on `GatewayClient`/`LlmClient`/`createEchoOpsAgent`,
  and `LlmLike` fakes the model for the loop.
- `vitest.config.ts` pins `include: ["tests/**/*.test.ts"]`, `globals: false`
  (import `describe`/`it`/`expect` from `"vitest"` explicitly),
  `environment: "node"`.
- Behavior notes live as short comments in the test files (see
  `tests/llm-client.test.ts`, `tests/agent-loop.test.ts`) mirroring the M0/M1
  findings.
- The **live** path is never tested in CI directories: it is `npm run smoke`
  and, later (M4), a separate live-smoke job. CI stays fixture-based.

## Build layout

```
tsconfig.json        noEmit, includes src + tests + vitest.config.ts (typecheck/test surface)
tsconfig.build.json  extends tsconfig; noEmit:false, rootDir src, outDir dist, declarations+sourcemaps
dist/                emitted ESM + .d.ts + .map files (mirrors src/ layout)
```

`dist/` is ESM with the *same relative paths* as `src` — this is what makes the
`.js` import convention valid in both places. Nothing under `tests/` or
`vitest.config.ts` is ever emitted.

## Which file implements what

| Concern | File |
| --- | --- |
| Env validation + defaults | `src/core/config.ts` |
| Loop semantics, stop conditions | `src/core/agent-loop.ts` |
| Chat wire format, effective model, `cache_info` | `src/core/llm-client.ts` |
| Transport, auth header, timeouts, health checks | `src/core/gateway/gateway-client.ts` |
| Error mapping / Retry-After | `src/core/errors.ts` |
| Tool registration → OpenAI schema | `src/core/tools/registry.ts` |
| Arg validation, timeout, structured outcomes | `src/core/tools/executor.ts` |
| Echo Ops prompt + wiring | `src/agents/echo-ops/` |
