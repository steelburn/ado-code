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
- `docs/` — documentation
- `out/` — compiled output; tests run from out/test/runTest.js
- `resources/` — extension resources
- `scripts/` — repository scripts
- `src/` — extension entry point and services composition root per AGENTS.md
- `webview-ui-dist/` — built webview output

## Repository Understanding
> Distilled from the ADO Code repository-understanding cache (`.ado-code/understanding/`).
> Refreshed automatically as the repository changes and via "ADO Code: Refresh Repository Understanding".
> This section and the other generated sections above are rewritten when ADO Code syncs AGENTS.md — edits anywhere else are preserved.

# ADO Code — Repository Understanding

### Layout & Docs
Root: `d:\Development\vscode\ado-code`  
Branch `main`, HEAD `50b27af`, remote `steelburn/ado-code`.

```
docs/ resources/ scripts/ src/
.eslintrc.json .gitignore .vscodeignore
AGENTS.md CHANGELOG.md README.md
package.json package-lock.json tsconfig.json
ado-code-0.6.7.vsix ado-code-0.6.8.vsix
```

`AGENTS.md` also lists `out/` (TypeScript compile output/test runner path) and `webview-ui-dist/`.

Docs live in:
- `AGENTS.md` — authoritative build/test/structure notes
- `README.md` — feature/workflow overview
- `docs/` — documentation

Read first: `AGENTS.md`, `README.md`, `package.json`, then `src/`.

### Key Entry Files
- `src/` — extension entry point and services composition root per `AGENTS.md`
- `src/webview-ui/` — webview source package; built via `npm run build:webview`
- `out/` — compiled output; tests run from `out/test/runTest.js`
- `package.json` — scripts, name/version, dev dependencies
- `resources/`, `scripts/`, `docs/` — supporting assets/scripts/docs

### Architecture
ADO Code is a VS Code AI coding assistant with Azure DevOps work item integration. The core TypeScript code lives in `src/`; `src/` is described as the extension entry point and services composition root. The webview UI is a separate package under `src/webview-ui`, built into `webview-ui-dist/`.

README features indicate:
- ADO work item tree view with mode toggle (My / All / Unassigned) and Epic → Feature → User Story → Task hierarchy
- AI chat with OpenAI-compatible and Anthropic-compatible LLM support
- Tool-calling agentic loop with Chat/Plan/Act/YOLO modes, parallel tool calls, batched edits/commands, `search_files`
- Git-based task workflow: branch on pickup, update `CHANGELOG.md` on completion
- External agent orchestration (README text truncated)

Repository understanding is cached in `.ado-code/understanding/` and refreshed automatically or via `ADO Code: Refresh Repository Understanding`. `AGENTS.md` contains managed sections (`<!-- ado-code:managed -->`) rewritten on sync.

### Key Modules/Directories
- `src/` — main extension logic and service composition
- `src/webview-ui/` — separate webview frontend package
- `out/` — compiled JS and test runner path
- `webview-ui-dist/` — built webview output
- `resources/` — extension resources
- `scripts/` — repository scripts
- `docs/` — docs

### Conventions
- TypeScript project compiled with `tsc -p ./`
- ESLint at root; lint command targets `src`
- Tests use `@vscode/test-electron`, `mocha`, `glob`; runner is `out/test/runTest.js`
- Webview is a nested npm package; `build:webview` runs `npm install && npm run build` inside `src/webview-ui`
- `husky` + `lint-staged` dev deps; `prepare` runs `husky`
- No explicit naming or error-handling conventions are visible in the
<!-- ado-code:managed-end -->

## Conventions
- TypeScript strict mode, ES modules → CommonJS
- Zero runtime dependencies (devDependencies only)
- No external UI libraries (VS Code CSS variables)
- Workspace-relative paths (path confinement enforced)
- ADO API: api-version=7.1 (GA) or 7.1-preview.4 (comments)
- Tool errors return JSON { error: string }, never throw

## What NOT to Do
- Do not add runtime dependencies without approval
- Do not use any types where avoidable
- Do not skip approval hook for mutating tools in inline mode
- Do not use preview API versions where GA exists
- Do not commit without npm run compile && npm test passing
