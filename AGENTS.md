# AGENTS.md — ADO Code

<!-- ado-code:managed -->
## What This Is
AI coding assistant with Azure DevOps integration

## Build & Test
- `npm run compile` — TypeScript compilation
- `npm run build:all` — Full build
- `npm test` — Run test suite
- `npm run lint` — Linting

## Project Structure
- `dist/` — project directory
- `docs/` — supporting documentation
- `out/` — project directory
- `resources/` — static resources
- `scripts/` — build, version check, Open VSX publish, and VS Code stub for unit tests
- `src/` — extension source and webview UI
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

# ADO Code — Repository Map

Repo root: `d:\Development\vscode\ado-code`  
Branch: `main` · HEAD: `a6dae09` · Remote: `https://github.com/steelburn/ado-code.git`

### Structure & docs

```
.github/
docs/
resources/
scripts/
src/
  webview-ui/        # separate webview build target
AGENTS.md
README.md
CHANGELOG.md
package.json
tsconfig.json
.eslintrc.json
```

Documentation lives in:
- `README.md` — feature overview and behavior.
- `AGENTS.md` — conventions, constraints, “What NOT to Do.”
- `docs/` — supporting documentation.

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
- Progress lives in the chat and the work item, not in a new markdown file
- Reference .ado-code/understanding/ and AGENTS.md; do not duplicate them
- Do not add ad-hoc files under .ado-code/ (it is garbage-collected) — the one exception is .ado-code/test-scratch, the suites' throwaway root (gitignored, wiped by every Electron run)

## What NOT to Do
- Do not add runtime dependencies without approval
- Do not use any types where avoidable
- Do not skip approval hook for mutating tools in inline mode
- Do not use preview API versions where GA exists
- Do not commit without npm run compile && npm test passing
