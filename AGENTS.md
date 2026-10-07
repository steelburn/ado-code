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
- `docs/` — documentation
- `out/` — project directory
- `resources/` — extension resources
- `scripts/` — build/version/publish helpers and vscode-stub.js
- `src/` — extension source; src/webview-ui/ — separate webview app
- `webview-ui-dist/` — generated outputs; do not edit directly

## Repository Understanding
> Distilled from the ADO Code repository-understanding cache (`.ado-code/understanding/`).
> Refreshed automatically as the repository changes and via "ADO Code: Refresh Repository Understanding".
> This section and the other generated sections above are rewritten when ADO Code syncs AGENTS.md — edits anywhere else are preserved.

# ADO Code — Repository Understanding

### Layout & docs
```
.github/          GitHub config
docs/             documentation
resources/        extension resources
scripts/          build, version, publish scripts
src/              TypeScript extension source + webview-ui
dist/             generated bundled runtime entry (dist/extension.js)
out/              generated tsc output; tests run from out/test/runTest.js
webview-ui-dist/  generated webview output
AGENTS.md         agent/build/structure guide; has managed/generated sections
README.md         feature overview
package.json      scripts, deps, version 0.7.1
tsconfig.json     TypeScript config
.eslintrc.json    ESLint config
```
Docs live in `README.md`, `AGENTS.md`, and `docs/`. `AGENTS.md` contains `ado-code:managed` and generated repository-understanding sections that are rewritten on sync.

### Read-first entry files
- `package.json` — version, scripts, deps.
- `AGENTS.md` — build/test/structure and repo map.
- `README.md` — feature overview.
- `tsconfig.json`, `.eslintrc.json` — compiler/lint rules.
- `scripts/build.js`, `scripts/check-version.js`, `scripts/publish-open-vsx.js`, `scripts/vscode-stub.js`.
- `src/` — extension source; `src/webview-ui/` — separate webview app.
- `out/test/runTest.js` — target of `npm test`.

### Architecture
VS Code extension for AI coding assistance with Azure DevOps work-item integration. TypeScript source lives under `src/`; `tsc` compiles to `out/`; `scripts/build.js` bundles the runtime entry to `dist/extension.js`. The webview is a separate npm project under `src/webview-ui/`, built to `webview-ui-dist/`. `resources/` holds extension assets. `scripts/` handles build, version checks, publishing. Tests run through `@vscode/test-electron`/Mocha from compiled `out/`.

### Key modules/directories
- `src/` — TypeScript extension source plus `webview-ui`.
- `src/webview-ui/` — separate webview app with its own install/build scripts.
- `scripts/` — build/version/publish helpers and `vscode-stub.js`.
- `resources/` — extension resources.
- `docs/` — documentation.
- `dist/`, `out/`, `webview-ui-dist/` — generated outputs; do not edit directly.
- Root `.tmp-*` and `*.vsix` files — scratch/packaged artifacts, not source.

### Conventions
- TypeScript + ESLint; lint target is `eslint src --ext ts`.
- npm script naming uses colons: `build:webview`, `build:all`, `watch:bundle`, `test:unit`, `publish:open-vsx`.
- Testing: `npm test` runs compiled `out/test/runTest.js`; `test:unit` runs Mocha with `scripts/vscode-stub.js` against `out/test/suite/sha...`.
- Versioning: `package.json` is `0.7.1`; `vscode:prepublish` runs `check:version`.
- Error handling: no explicit convention is visible in the provided repository facts.
- `AGENTS.md` managed sections are auto-rewritten; edit
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
