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
- `resources/` — extension icons/assets
- `scripts/` — build, version, publish helpers; vscode-stub.js
- `src/` — TypeScript VS Code extension source
- `webview-ui-dist/` — referenced by AGENTS; webview-ui-dist/ is generated output and must not be edited directly

## Repository Understanding
> Distilled from the ADO Code repository-understanding cache (`.ado-code/understanding/`).
> Refreshed automatically as the repository changes and via "ADO Code: Refresh Repository Understanding".
> This section and the other generated sections above are rewritten when ADO Code syncs AGENTS.md — edits anywhere else are preserved.

# ADO Code — Repository Quick Map

Docs live in `README.md`, `AGENTS.md`, and `docs/`. `AGENTS.md` contains build/test/structure plus generated repository-understanding sections that ADO Code rewrites on sync; edits outside those managed sections are preserved.

### Layout
- `src/` — TypeScript VS Code extension source.
- `src/webview-ui/` — separate webview app; has its own build.
- `scripts/` — build, version, publish helpers; `vscode-stub.js`.
- `resources/` — extension icons/assets.
- `docs/` — documentation.
- `.github/` — GitHub config.
- `out/`, `dist/`, `webview-ui-dist/` — referenced by AGENTS; `webview-ui-dist/` is generated output and must not be edited directly.
- Root configs/artifacts: `package.json`, `tsconfig.json`, `.eslintrc.json`, `.env`, `.vscodeignore`, `.gitignore`, several `.vsix` files.

### Read First
`README.md`, `AGENTS.md`, `package.json`, `tsconfig.json`, `.eslintrc.json`, `scripts/build.js`, `scripts/check-version.js`, `scripts/vscode-stub.js`, `src/` extension source, `src/webview-ui/package.json`.

### Architecture
VS Code extension: AI coding assistant with Azure DevOps work-item integration. README features include one tree view for work items with My Work Items / All Work Items / Unassigned modes, rendered as Epic → Feature → User Story → Task, plus an AI chat assistant. Main extension is TypeScript in `src/`, compiled with `tsc -p ./`; tests run from `out/`. Bundling is via `scripts/build.js`. The webview UI is a separate app under `src/webview-ui/`, built separately.

### Build / Test / Lint
- Compile: `npm run compile`
- Full build: `npm run build:all` = compile + bundle + webview build
- Bundle: `npm run bundle`; watch: `npm run watch:bundle`
- TypeScript watch: `npm run watch`
- Webview build: `npm run build:webview`; watch: `npm run watch:webview`
- Test: `npm test` → `node ./out/test/runTest.js`
- Unit test: `npm run test:unit` → Mocha TDD + `scripts/vscode-stub.js`
- Lint: `npm run lint` → `eslint src --ext ts`
- Version check: `npm run check:version`
- Pre-publish: `npm run vscode:prepublish` = check version + compile + bundle
- Publish Open VSX: `npm run publish:open-vsx`

### Conventions & Gotchas
- Structure split: extension code in `src/`; webview app in `src/webview-ui/`; helpers in `scripts/`.
- Generated outputs (`webview-ui-dist/`; `out/`, `dist/` per AGENTS) should not be hand-edited.
- `AGENTS.md` managed sections are auto-rewritten on sync.
- `npm test` uses VS Code test Electron; unit tests use Mocha TDD and a VS Code stub.
- Dev tooling includes TypeScript, ESLint, esbuild, Mocha, `@vscode/test-electron`, and zod; Husky `prepare` and lint-staged are present.
- No explicit error-handling convention is visible in the supplied facts; follow existing patterns in `src/`.
- `package.json` version is `0.7.
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
- Do not add ad-hoc files under .ado-code/ (it is garbage-collected)

## What NOT to Do
- Do not add runtime dependencies without approval
- Do not use any types where avoidable
- Do not skip approval hook for mutating tools in inline mode
- Do not use preview API versions where GA exists
- Do not commit without npm run compile && npm test passing
