# ADR 0001 — ESM + NodeNext, and why relative imports end in `.js`

- **Status:** accepted
- **Date:** 2026-10-18
- **Scope:** package format, module resolution, import conventions
- **Context code:** `"type": "module"` in `package.json`; `module`/`moduleResolution:
  "NodeNext"` in `tsconfig.json`; `module` on every relative import under `src/`
  and `tests/`

## Context

This package is a library (`main: dist/index.js`) consumed by Node at runtime,
not a bundle for the browser. Compile target decisions therefore have to
satisfy **real Node resolution**, and this repo is emphatic about it. Three
options were in play:

1. **ESM output** (`"type": "module"`, NodeNext)
2. CommonJS output (`module: "commonjs"`)
3. ESM with a transform step (write `.ts` extensions, rewrite at emit)

Constraints that made this non-trivial:

- Under Node's ESM resolver there is **no extension inference** —
  `import "./foo"` throws `ERR_MODULE_NOT_FOUND` at runtime (it works only under
  CommonJS `require` heuristics). Since `"main"` points at emitted JS and the
  entry is `"type": "module"`, the literal string written in the source becomes
  the string resolved at runtime.
- **TypeScript never rewrites import specifiers** on emit (apart from the
  narrow `rewriteRelativeImportExtensions` transform); they pass through
  verbatim into `dist/`.
- TypeScript's own resolution under NodeNext, for a relative specifier ending in
  `.js`, checks on disk for the sibling `.ts` — it is exact-match, not a
  convention.

So at the moment of the decision there were already two customer refusing the
"natural" ways to write relative imports:

- `import "./foo"` → runtime `ERR_MODULE_NOT_FOUND` in emitted ESM, and a
  compile error: `TS2835 Relative import paths need explicit file extensions in
  ECMAScript imports when '--moduleResolution' is 'node16' or 'nodenext'`.
- `import "./foo.ts"` → compile error `TS5097` (extension `.ts` only allowed for
  `allowImportingTsExtensions`, which requires no emit).

Verified locally against this repo's `tsconfig.json` (probe file compiled with
"noEmit") — both errors reproduce exactly as documented above.

## Decision

- Package format: **ESM** (`"type": "module"`, `"module": "NodeNext"`,
  `"moduleResolution": "NodeNext"`).
- **Relative imports end in `.js` even inside `.ts` sources.** One specifier
  string serves both resolvers:
  - typecheck: NodeNext maps `./foo.js` → `./foo.ts` on disk;
  - runtime: Node resolves the emitted `dist/foo.js` literally.
- No CJS build target and no bundler/transform step.
- Bare specifiers (`zod`, `node:crypto`, `vitest/config` …) are exempt — the
  rule is only for relative paths.

## Alternatives considered

- **CommonJS build instead.** Cheap on a "feels simpler on day one" basis and
  makes extensionless imports legal again. Rejected: it locks a 0.1 harness into
  the format every significant toolchain (vitest, tsx, zod) is moving away from;
  and Node ≥ 22's `require(esm)` has since eroded CJS's remaining compatibility
  advantage.
- **`.ts` extensions + `rewriteRelativeImportExtensions`.** Makes source read
  like what it is, at the cost of an extra emit transform. Rejected: adds a
  nonstandard transform to a library consumed by unknown Node versions, for a
  naming-preference gain.

## Consequences

**Positive:**

- Identical specifier text works in typecheck, tests, and runtime — a single
  source of truth for module identity.
- `dist/` runs on Node without a bundler; `d.ts` publishes cleanly alongside.
- Testing/`smoke`/`node --test`/`tsx`/`vitest` all agree on resolution.

**Negative / costs to be aware of:**

- Every `.ts`→new-file rename is mentally checked against *all* importers'
  strings.
- IDE may suggest a `.ts` extension; accepting it is a compile error (tripwire
  already hit in practice — see AGENTS.md hard rule 1).
- Documentation must repeat the rule wherever new contributors or agents work in
  this repo (DEVELOPMENT.md, CONTRIBUTING.md, AGENTS.md, this ADR).
