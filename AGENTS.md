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
- `docs/` — project directory
- `out/` — project directory
- `resources/` — project directory
- `scripts/` — project directory
- `src/` — project directory
- `webview-ui-dist/` — project directory

## Repository Understanding
> Distilled from the ADO Code repository-understanding cache (`.ado-code/understanding/`).
> Refreshed automatically as the repository changes and via "ADO Code: Refresh Repository Understanding".
> This section and the other generated sections above are rewritten when ADO Code syncs AGENTS.md — edits anywhere else are preserved.

# ADO Code — Repo Map

### Layout & docs
```
.github/          GitHub config
docs/             documentation
resources/        extension resources
scripts/           build, version, publish scripts
src/              TypeScript extension source + webview-ui
.eslintrc.json    ESLint config
AGENTS.md         agent/build/structure guide
README.md         feature overview
package.json      scripts, deps, version 0.7.1
tsconfig.json     TypeScript config
dist/             generated bundled runtime entry (dist/extension.js)
out/              generated tsc output; tests run from out/test/runTest.js
webview-ui-dist/  generated webview output
```
Docs live in `README.md`, `AGENTS.md`, and `docs/`. `AGENTS.md` contains managed sections marked `<!-- ado-code:managed -->`; sync rewrites those, preserves edits elsewhere.

### Read first
- `AGENTS.md` — build/test commands, project structure, generated repository understanding.
- `README.md` — feature overview: Azure DevOps work item tree, AI chat, OpenAI/Anthropic-compatible LLMs, tool calling/agentic loop.
- `package.json` — scripts and runtime entry (`dist/extension.js`).
- `src/extension.ts` — source entry bundled by `scripts/build.js`.
- `scripts/build.js` — esbuild bundling.
- `src/webview-ui/` — separate webview UI package.
- `out/test/runTest.js` — VS Code test runner entry.

### Architecture
VS Code extension with Azure DevOps work item integration. TypeScript source lives in `src/`; `tsc` emits to `out/`, while esbuild bundles `src/extension.ts` to `dist/extension.js`, which is the actual runtime entry. Webview UI is built separately from `src/webview-ui` into `webview-ui-dist/`. Per `AGENTS.md`, `src/` is the extension entry point and services composition root. The README describes work item hierarchy rendering (Epic → Feature → User Story → Task), a mode toggle (My Work Items / All Work Items / Unassigned), and an AI chat assistant with agentic tool calling.

### Conventions visible in repo
- Managed agent sections in `AGENTS.md` are auto-rewritten; edit outside those markers.
- Build outputs are separated: `out/` for `tsc`, `dist/` for runtime bundle, `webview-ui-dist/` for webview.
- Lint targets `src` via `eslint src --ext ts`.
- Tests run from compiled `out/`, not raw `src/`.
- Unit tests use Mocha TDD plus `scripts/vscode-stub.js`.
- Husky is prepared via `npm run prepare`; `lint-staged` is a devDependency.
- Version consistency is checked by `npm run check:version` before publish.

### Build, test, lint
- `npm run compile` — `tsc -p ./` → `out/`
- `npm run bundle` — `node scripts/build.js` → `dist/extension.js`
- `npm run build:all` — compile + bundle + webview
- `npm run build:webview` — `cd src/webview-ui && npm install && npm run build`
- `npm test` — `node ./out/test/runTest.js`
- `npm run test:uni
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
