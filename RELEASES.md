# Releases

Versioning, process, and the pre-publish checklist. Current published version:
**none** (development only; `package.json` is at `0.1.0`).

## Versioning policy

- [SemVer](https://semver.org/) from `0.y.z` forward.
- Before 1.0, minor bumps may contain breaking changes (they are marked
  `Changed`/`Removed` in the changelog); after 1.0, breaking changes require a
  major bump.
- Keep `main` releasable: `npm run build && npm test` green at all times.

## Release process

1. Finalize the milestone/feature set; update `CHANGELOG.md` (Keep a Changelog
   format — `Unreleased → Added/Changed/Fixed/Removed`).
2. Run the full gate:
   ```bash
   npm run typecheck
   npm test
   npm run build
   ```
3. Bump `version` in `package.json`, update `CHANGELOG.md` heading, commit
   (`release: vX.Y.Z`), tag `vX.Y.Z`.
4. Pack to inspect exactly what would ship:
   ```bash
   npm pack --dry-run
   ```
5. Publish via `npm publish` (requires either `--access public` for a scoped
   package, or an unscoped name — `agent-forge` is unscoped).

## What ships

From `package.json` (`files` is not currently set — so the tarball includes
everything not git-ignored):

| Field | Value | Role |
| --- | --- | --- |
| `main` | `dist/index.js` | ESM entry |
| `types` | `dist/index.d.ts` | Surface for consumers |
| `engines` | `node >= 20` | Hard requirement (fetch is global; AbortController semantics) |

`dist/` is ESM only, built fresh by `npm run build`. There is intentionally
**no CommonJS build** (ADR 0001) — consumers running CJS rely on Node ≥ 22's
`require(esm)` or an ESM import.

## Pre-publish checklist (do this once, before the first publish)

- [ ] `package.json`: set `files` (e.g. `["dist", "README.md", "CHANGELOG.md", "LICENSE"]`) so local state doesn't leak into the tarball.
- [ ] `package.json`: license field is `MIT` and [LICENSE](./LICENSE) is present (✅ done).
- [ ] Decide npm org/name availability for `agent-forge`; consider scoping (e.g. `@echo/agent-forge`).
- [ ] Remove/`finalize` dev-only fields (`scripts` referencing a private gateway are fine, but confirm no secrets in any file that ships).
- [ ] `README.md` + `docs/` statements (test counts, feature status) match the release snapshot.
- [ ] `CHANGELOG.md` has a dated release section.
- [ ] First release executes `npm run release`-style steps manually (no
      release automation yet — add provenance/SBOM generation if/when needed).

## Post-release checklist

- [ ] Published dist has correct `engine` warning behavior on Node 20 vs 22 (`require(esm)` consumers).
- [ ] Reset `version`-bumped changelog `Unreleased` header for next work.
- [ ] Update ROADMAP milestone statuses if the release marks a milestone (e.g. M2).
