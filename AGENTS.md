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

# ADO Code — Repository Map

VS Code extension: AI coding assistant with Azure DevOps work-item integration. Root `d:\Development\vscode\ado-code`, branch `main`, HEAD `4932aa2`, remote `steelburn/ado-code`.

### Layout & Docs

```
.github/          GitHub config
docs/             documentation
resources/        extension resources (icons/assets)
scripts/          build, version, publish helpers + vscode-stub.js
src/              TypeScript extension source
src/webview-ui/   separate webview app (own npm project)
dist/             generated bundle entry (dist/extension.js)
out/              generated tsc output; tests run from out/test/runTest.js
webview-ui-dist/  generated webview output
README.md         features + usage
AGENTS.md         agent/build/structure guide (managed sections)
CHANGELOG.md      release history
```

Root also holds `package.json`, `package-lock.json`, `tsconfig.json`, `.eslintrc.json`, `.env`, `.vscodeignore`, `scripts/`, and committed `.vsix` artifacts (0.6.7–0.7.3).

### Read First

1. `package.json` — extension manifest, scripts, version `0.7.3`.
2. `AGENTS.md` — build/structure contract and the generated "Repository Understanding" section.
3. `README.md` — feature surface (work-item tree with My/All/Unassigned toggle and Epic → Feature → User Story → Task hierarchy; AI chat assistant with OpenAI-compatible and Anthropic-compatible LLMs).
4. `scripts/build.js` and `scripts/check-version.js` — bundling and version guards.
5. `src/` root and `src/webview-ui/` — extension host code vs. webview UI.

### Architecture

Two halves built separately:

- **Extension host** — `src/`, compiled by `tsc` into `out/`, then bundled by `scripts/build.js` (esbuild) into `dist/extension.js`, which `vscode:prepublish` treats as the runtime entry.
- **Webview UI** — `src/webview-ui/` is an independent npm project with its own `build`/`watch` scripts, emitting to `webview-ui-dist/` (referenced by AGENTS.md as generated output).

Supporting layers: `resources/` for static assets, `scripts/` for build/version/publish automation plus `vscode-stub.js` (used by unit tests to fake the VS Code API), `docs/` for prose documentation.

### Conventions

- TypeScript throughout, strict config in `tsconfig.json`; linting via ESLint + `@typescript-eslint`.
- Source lives under `src/`; never hand-edit `dist/`, `out/`, or `webview-ui-dist/`.
- `AGENTS.md` uses managed markers (`<!-- ado-code:managed -->`). Generated sections are rewritten on ADO Code sync — edits outside those sections are preserved.
- Husky + lint-staged wired via the `prepare` script.
- Version consistency is enforced by `scripts/check-version.js`, so version bumps must be coordinated (manifest/CHANGELOG).
- Error-handling patterns are not documented in the available facts; inspect `src/` befor
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
