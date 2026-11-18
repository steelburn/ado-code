# AGENTS.md — ADO Code

<!-- ado-code:managed -->
## What This Is
AI coding assistant with Azure DevOps integration

## Build & Test
- Tier 1 — every edit: `npm run compile` (seconds, and a handful of lines of output)
- Tier 2 — while iterating (default): `npm run test:changed` (seconds, and only the suites you broke print anything)
- Tier 3 — before commit: `npm test` (minutes, and the whole reporter output is billed to the user)
- Tier 4 — on request only: `npm run test:host` (minutes or more, and the loudest output of all: GUI, browser or host download)
- Default: run the cheapest tier that can fail because of your change; escalate one tier at a time and name the tier you ran.
- Testing is billed to the user in tokens: quote only the failing test and the head of its error, prefer one file or a `--grep <name>` filter over the whole suite, and never paste a full test log.
- A red run already names the failing tests: read that block instead of re-running the suite to see the failure.
- `npm run build:all` — Full build
- `npm run lint` — Linting

## Project Structure
- `dist/` — project directory
- `docs/` — project directory
- `out/` — project directory
- `resources/` — project directory
- `scripts/` — compile/bundle/test/version/publish automation
- `src/` — extension logic (LLM, prompts, ADO client, tools, commands)
- `webview-ui-dist/` — project directory

## Documentation Conventions
- Extend an existing document instead of adding a per-step or per-turn .md file.
- Record progress in the chat or the work item, never in a new markdown file.
- One new doc per change, and only when documentation was requested.
- Reference `.ado-code/understanding/` and this file instead of duplicating them.
- Do not add files under `.ado-code/`; that tree is garbage-collected.

## Repository Understanding
> Digest of the ADO Code repository-understanding cache; refreshed automatically
> as the repository changes and via "ADO Code: Refresh Repository Understanding".
> The managed sections above and this digest are rewritten when ADO Code syncs
> AGENTS.md — everything outside the managed block is preserved.

# ADO Code — Repository Guide

VS Code extension: AI coding assistant with Azure DevOps work-item integration.

### Layout

```
.github/        GitHub metadata
docs/           Documentation
resources/      Extension assets
scripts/        Build/test/version/publish tooling
src/            Extension source
src/webview-ui/ Separate webview UI (own npm build)
AGENTS.md       Agent/contributor conventions (authoritative)
README.md       Features and usage
CHANGELOG.md
package.json    Manifest, scripts, devDependencies
tsconfig.json   TypeScript config
.eslintrc.json  Lint config
```

_…digest cut at 600 characters._
> Full map: `.ado-code/understanding/repo.md` — read the line ranges you need instead of copying it here.
<!-- ado-code:managed-end -->

## Conventions
- TypeScript strict mode, ES modules → CommonJS
- Zero runtime dependencies (devDependencies only)
- No external UI libraries (VS Code CSS variables)
- Workspace-relative paths (path confinement enforced)
- ADO API: api-version=7.1 (GA) or 7.1-preview.4 (comments)
- Tool errors return JSON { error: string }, never throw
- Docs budget: extend an existing document; never a .md per step or per turn
- System prompt: `generateSystemPrompt()` in `src/llm/prompts/system.ts` is the only builder — static sections first, per-turn sections (to-do, skills, user/workspace memory, understanding, custom instructions) last so provider prefix caching hits. A size-budget test caps the static prompt at 7,200 chars; the understanding block is capped per part (repo 4,500 / work item 2,500 / knowledge 1,500, 8,000 total). Never add a second injection point
- Progress lives in the chat and the work item, not in a new markdown file
- Reference .ado-code/understanding/ and AGENTS.md; do not duplicate them
- Keep `docs/` to live references (`remote.md`, `documentation-projects.md`, `playbooks/`); an executed plan ends up in CHANGELOG.md, the code and the work item, never in a plan file
- Do not add ad-hoc files under .ado-code/ (it is garbage-collected) — the one exception is .ado-code/test-scratch, the suites' throwaway root (gitignored, wiped by every Electron run)

## Verification — test tiers
Cheap by default; the Electron host is the exception, not the routine gate.
- every edit: `npm run compile` (~3s, incremental)
- while iterating: `npm run test:changed` — only the suites the diff touches (`--dry-run` lists them, `--grep <name>` narrows further)
- before commit: `npm test` — all 132 suites headlessly under scripts/vscode-stub.js: 2049 tests, ~95s, ONE line of output when green, failure block capped at 12k chars
- before a PR, or where the real vscode API is the thing under test: `npm run test:host` (minutes, GUI, very noisy). The stub is permissive, so this is the only check that catches a vacuous pass — which is why it stays available, not why it stays routine.
- A red run prints the failing tests only. Read that block; do not re-run the whole suite to "see" a failure.
- Global blast radius (package.json, tsconfig.json, scripts/, src/shared/, src/webview-ui/, src/test/) always escalates `--changed` to the full suite — by design, not a bug

## What NOT to Do
- Do not add runtime dependencies without approval
- Do not use any types where avoidable
- Do not skip approval hook for mutating tools in inline mode
- Do not use preview API versions where GA exists
- Do not commit without `npm run compile` and `npm test` green (see Verification — test tiers)
