# Playbook — Releasing a version

The extension version is written down in **two** places. Both must be in sync, and
`package.json` is the source of truth.

| Where | What |
|---|---|
| `package.json` → `version` | the marketplace manifest version (source of truth) |
| `src/shared/version.ts` → `EXTENSION_VERSION` | the version announced to LLM providers via `ADO_CODE_USER_AGENT` |

## Why there is a gate

The two drifted once: the manifest reached `0.7.0` while `EXTENSION_VERSION`
stayed `0.6.7`, so every LLM request on the 0.7.0 release announced
`ADO-Code/0.6.7 (+https://github.com/steelburn/ado-code)` — provider and gateway
logs were wrong for the whole release and nothing flagged it.

The version must therefore be interpolated from `EXTENSION_VERSION`, never
written as a second literal. Providers import `ADO_CODE_USER_AGENT`; do not
format your own header.

## Enforcement (four layers)

1. `src/test/suite/shared/version.test.ts` — asserts `EXTENSION_VERSION ===
   package.json.version`, that the value is a bare semver release, that the
   User-Agent interpolates the constant, and that no non-test source file
   hardcodes an `ADO-Code/<version>` string.
2. `scripts/check-version.js` — dependency-free, no compile required. Fails on
   drift, on a missing constant, or on a re-hardcoded User-Agent.
3. Hooked into `scripts/pre-commit.js` (fast fail before the test suite) and into
   `vscode:prepublish`, which `vsce package` / `vsce publish` invoke — so a
   mismatched pair cannot be packaged.
4. `.github/workflows/version-check.yml` — the server-side layer: `check:version`
   as a status check on every PR (and on pushes to `main`). Local hooks can be
   bypassed with `git commit --no-verify`; a required PR check cannot. The job
   deliberately has **no** `paths:` filter — a filtered-out workflow never
   reports, so a required check would leave the PR blocked forever. It also
   carries a self-test step that drifts the constant on purpose and asserts the
   gate exits exactly 1, so a neutered or crashing gate cannot pass as coverage.

If branch protection is reconfigured, keep the `check:version` job
(`check-version` in `version-check.yml`) in the required list.

## Release steps

1. Bump `package.json` `version` **and** `EXTENSION_VERSION` in
   `src/shared/version.ts` to the same value.
2. Move the `## [Unreleased]` CHANGELOG entries under a new
   `## [x.y.z] - <date>` heading, leaving an empty `## [Unreleased]`.
3. `npm run compile && npm run check:version` (or just `npm test`).
4. `npx vsce package --allow-missing-repository` — the prepublish gate
   re-checks the pair as part of packaging.
5. Merge — CI runs `check:version` on the PR (see the workflow above); it must
   be green before merge.

Do not bump the version for ordinary work — new changes go under
`## [Unreleased]`.
