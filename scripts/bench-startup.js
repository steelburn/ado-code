#!/usr/bin/env node
'use strict';
/**
 * ADO Code — startup / activation loading benchmark.
 *
 * Measures the two costs that dominate extension activation:
 *   1. Module-graph load  — `require(<entry>)` time + number/size of the
 *      modules that actually got pulled in (`require.cache`).
 *   2. Service construction — `createServices(fakeContext)` time, plus a
 *      "touch every service" pass that forces lazy services to materialise.
 *
 * The `vscode` module is not available outside the extension host, so it is
 * stubbed below. The stub is intentionally permissive (explicit impls for the
 * APIs we rely on + a generic fallback) so that merely *loading* the module
 * graph does not fail.
 *
 * Usage:
 *   node scripts/bench-startup.js [--entry <file.js>] [--services] [--json]
 *       [--runs <n>]
 *
 * One entry per process (require cache is process-global); the caller runs the
 * script once per entry to compare, e.g. out/extension.js vs dist/extension.js.
 */
const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const ENTRY = path.resolve(ROOT, arg('--entry') || path.join('out', 'extension.js'));
const WITH_SERVICES = process.argv.includes('--services');
const WITH_ACTIVATE = process.argv.includes('--activate');
const WITH_TASKS = process.argv.includes('--tasks');
const AS_JSON = process.argv.includes('--json');
const RUNS = Math.max(1, parseInt(arg('--runs') || '1', 10));
const TOP = Math.max(0, parseInt(arg('--top') || '5', 10));

// ── vscode stub ────────────────────────────────────────────────────────────
function generic(name) {
  const fn = function () { return generic(name + '()'); };
  return new Proxy(fn, {
    get(_t, p) {
      if (p === 'then') return undefined;
      if (p === Symbol.toPrimitive) return () => name;
      if (p === 'toString') return () => name;
      if (p === 'valueOf') return () => name;
      if (p === 'fsPath' || p === 'path' || p === 'scheme' || p === 'authority' || p === 'query' || p === 'fragment') return '';
      if (p === 'length' || p === 'size') return 0;
      if (p === 'Symbol(util.inspect.custom)') return undefined;
      return generic(name + '.' + String(p));
    },
    apply() { return generic(name + '()'); },
    construct() { return generic('new ' + name); },
  });
}

function withFallback(obj, name) {
  return new Proxy(obj, {
    get(t, p) {
      if (typeof p === 'symbol') return t[p];
      return p in t ? t[p] : generic(`${name}.${String(p)}`);
    },
    has() { return true; },
  });
}

function makeVscodeStub() {
  const cwd = process.cwd();
  const workspaceFolder = {
    uri: { fsPath: cwd, path: cwd, scheme: 'file', toString: () => 'file://' + cwd },
    name: 'bench',
    index: 0,
  };
  const configuration = {
    get: (_k, d) => d,
    has: () => false,
    inspect: () => undefined,
    update: async () => {},
  };
  const disposable = () => ({ dispose() {} });

  const workspace = {
    workspaceFolders: [workspaceFolder],
    rootPath: cwd,
    name: 'bench',
    textDocuments: [],
    getConfiguration: () => configuration,
    onDidChangeConfiguration: disposable,
    onDidChangeWorkspaceFolders: disposable,
    onDidChangeTextDocument: disposable,
    onDidSaveTextDocument: disposable,
    onDidOpenTextDocument: disposable,
    onDidCloseTextDocument: disposable,
    onDidCreateFiles: disposable,
    onDidRenameFiles: disposable,
    onDidDeleteFiles: disposable,
    createFileSystemWatcher: () => ({ onDidChange: disposable, onDidCreate: disposable, onDidDelete: disposable, dispose() {} }),
    findFiles: async () => [],
    openTextDocument: async () => generic('TextDocument'),
    asRelativePath: (p) => String(p),
    fs: {
      readFile: async () => new Uint8Array(),
      writeFile: async () => {},
      delete: async () => {},
      rename: async () => {},
      copy: async () => {},
      createDirectory: async () => {},
      stat: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
    },
  };

  const window = {
    createTreeView: () => ({
      visible: false,
      selection: [],
      message: undefined,
      badge: undefined,
      title: undefined,
      reveal: async () => {},
      onDidChangeVisibility: disposable,
      onDidChangeSelection: disposable,
      onDidChangeCheckboxState: disposable,
      onDidExpandElement: disposable,
      onDidCollapseElement: disposable,
      dispose() {},
    }),
    registerTreeDataProvider: disposable,
    registerWebviewViewProvider: disposable,
    registerWebviewPanelSerializer: disposable,
    createStatusBarItem: () => ({ text: '', tooltip: '', command: '', show() {}, hide() {}, dispose() {} }),
    createOutputChannel: () => ({ name: 'bench', append() {}, appendLine() {}, replace() {}, clear() {}, show() {}, hide() {}, dispose() {} }),
    createTerminal: () => ({ show() {}, hide() {}, sendText() {}, dispose() {} }),
    createTextEditorDecorationType: disposable,
    createWebviewPanel: () => ({ webview: generic('webview'), onDidDispose: disposable, onDidChangeViewState: disposable, reveal() {}, dispose() {} }),
    showInformationMessage: async () => undefined,
    showWarningMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    showQuickPick: async () => undefined,
    showInputBox: async () => undefined,
    showOpenDialog: async () => undefined,
    withProgress: async (_o, task) => task({ report() {} }, { isCancellationRequested: false, onCancellationRequested: disposable }),
    activeTextEditor: undefined,
    visibleTextEditors: [],
    terminals: [],
    onDidChangeActiveTextEditor: disposable,
    onDidChangeVisibleTextEditors: disposable,
    onDidChangeTextEditorSelection: disposable,
  };

  const commands = {
    registerCommand: disposable,
    registerTextEditorCommand: disposable,
    executeCommand: async () => undefined,
    getCommands: async () => [],
  };

  const env = {
    appName: 'bench',
    language: 'en',
    machineId: 'bench',
    sessionId: 'bench',
    clipboard: { writeText: async () => {}, readText: async () => '' },
    openExternal: async () => true,
  };

  const Uri = {
    file: (p) => ({ fsPath: String(p), path: String(p), scheme: 'file', toString: () => 'file://' + p }),
    parse: (s) => ({ fsPath: String(s), path: String(s), scheme: 'file', toString: () => String(s) }),
    joinPath: (base, ...parts) => ({ fsPath: path.join(base.fsPath || base, ...parts) }),
    from: generic('Uri.from'),
  };

  class EventEmitter {
    constructor() { this.event = () => disposable(); }
    fire() {}
    dispose() {}
  }
  class Disposable {
    constructor(fn) { this.dispose = fn || (() => {}); }
    static from() { return disposable(); }
  }
  class ThemeIcon { constructor(id) { this.id = id; } }
  class ThemeColor { constructor(id) { this.id = id; } }
  class TreeItem { constructor(label, collapsibleState) { this.label = label; this.collapsibleState = collapsibleState; } }
  class MarkdownString { constructor(v) { this.value = v || ''; } appendText(t) { this.value += t; return this; } appendMarkdown(t) { this.value += t; return this; } }
  class LanguageModelToolResult { constructor(parts) { this.content = parts || []; } }
  class LanguageModelTextPart { constructor(v) { this.value = v; } }
  class Range { constructor(s, e) { this.start = s; this.end = e; } }
  class Position { constructor(line, character) { this.line = line; this.character = character; } }

  const base = {
    version: '1.96.0',
    workspace: withFallback(workspace, 'workspace'),
    window: withFallback(window, 'window'),
    commands: withFallback(commands, 'commands'),
    env: withFallback(env, 'env'),
    Uri: withFallback(Uri, 'Uri'),
    EventEmitter,
    Disposable,
    ThemeIcon,
    ThemeColor,
    TreeItem,
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    MarkdownString,
    LanguageModelToolResult,
    LanguageModelTextPart,
    Range,
    Position,
    ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    ExtensionMode: { Production: 1, Development: 2, Test: 3 },
    ExtensionKind: { UI: 1, Workspace: 2 },
    FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
    QuickPickItemKind: { Separator: -1, Default: 0 },
    ThemeKind: { Light: 1, Dark: 2, HighContrast: 3 },
    lm: { registerTool: disposable, tools: [], selectChatModels: async () => [] },
    languages: { registerCodeActionsProvider: disposable, registerHoverProvider: disposable },
    extensions: { getExtension: () => undefined, all: [] },
    tasks: { registerTaskProvider: disposable },
  };

  return new Proxy(base, {
    get(t, p) {
      if (typeof p === 'symbol') return t[p];
      return p in t ? t[p] : generic(String(p));
    },
    has() { return true; },
  });
}

function makeContext(root) {
  const mem = new Map();
  const state = {
    get: (k, d) => (mem.has(k) ? mem.get(k) : d),
    update: async (k, v) => { mem.set(k, v); },
    keys: () => [...mem.keys()],
  };
  const uri = (p) => ({ fsPath: p, path: p, scheme: 'file', toString: () => 'file://' + p });
  return {
    subscriptions: [],
    extensionPath: root,
    extensionUri: uri(root),
    globalState: state,
    workspaceState: state,
    secrets: { get: async () => undefined, store: async () => {}, delete: async () => {}, onDidChange: () => ({ dispose() {} }) },
    storageUri: uri(path.join(root, '.ado-code', 'storage')),
    globalStorageUri: uri(path.join(root, '.ado-code', 'gstorage')),
    logUri: uri(path.join(root, '.ado-code', 'logs')),
    extensionMode: 1,
    environmentVariableCollection: generic('envCollection'),
    asAbsolutePath: (p) => path.join(root, p),
    extension: { id: 'steelburn.ado-code', packageJSON: { name: 'ado-code', version: 'bench' } },
  };
}

// Install the stub before anything requires 'vscode'.
const vscodeStub = makeVscodeStub();
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscodeStub;
  return origLoad.call(this, request, parent, isMain);
};

function cacheStats() {
  let ownCount = 0, ownBytes = 0, depCount = 0, depBytes = 0;
  const modules = [];
  for (const file of Object.keys(require.cache)) {
    if (!file || file.startsWith('internal') || file.includes(`node:internal`)) continue;
    let size = 0;
    try { size = fs.statSync(file).size; } catch { /* synthetic entry */ }
    if (file.includes('node_modules')) { depCount++; depBytes += size; }
    else { ownCount++; ownBytes += size; }
    modules.push({ file: file.replace(ROOT + path.sep, '').replace(/\\/g, '/'), size });
  }
  modules.sort((a, b) => b.size - a.size);
  return { ownCount, ownBytes, depCount, depBytes, modules };
}

async function main() {
  if (!fs.existsSync(ENTRY)) {
    console.error(`bench: entry not found: ${ENTRY}`);
    process.exit(2);
  }
  const loads = [];
  let mod;
  for (let i = 0; i < RUNS; i++) {
    // Fresh-ish: drop the entry graph so each run re-reads modules.
    for (const key of Object.keys(require.cache)) {
      if (!key.includes('node_modules')) delete require.cache[key];
    }
    const t0 = process.hrtime.bigint();
    mod = require(ENTRY);
    loads.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  const stats = cacheStats();
  const loadMs = loads.reduce((a, b) => a + b, 0) / loads.length;

  const result = {
    entry: path.relative(ROOT, ENTRY).replace(/\\/g, '/'),
    loadMs: +loadMs.toFixed(2),
    loadRunsMs: loads.map((x) => +x.toFixed(2)),
    modules: { own: stats.ownCount, ownKB: +(stats.ownBytes / 1024).toFixed(1), deps: stats.depCount, depsKB: +(stats.depBytes / 1024).toFixed(1) },
    topModules: stats.modules.slice(0, TOP).map((m) => ({ file: m.file, KB: +(m.size / 1024).toFixed(1) })),
    exportedActivate: typeof mod?.activate === 'function',
  };

  if (WITH_SERVICES) {
    const servicesPath = path.join(ROOT, 'out', 'services.js');
    const { createServices } = require(servicesPath);
    const ctx = makeContext(ROOT);
    const t0 = process.hrtime.bigint();
    const services = createServices(ctx);
    result.servicesMs = +(Number(process.hrtime.bigint() - t0) / 1e6).toFixed(3);
    // Force lazy services to materialise.
    const names = ['ado', 'git', 'changelog', 'agents', 'checkpoints', 'mcp', 'skills', 'skillRegistry', 'projectCreation', 'workspaceMemory', 'memory', 'todos', 'understanding', 'logger'];
    const t1 = process.hrtime.bigint();
    for (const n of names) { void services[n]; }
    result.touchAllMs = +(Number(process.hrtime.bigint() - t1) / 1e6).toFixed(3);
  }

  if (WITH_SERVICES || WITH_TASKS || WITH_ACTIVATE) {
    const servicesPath = path.join(ROOT, 'out', 'services.js');
    const { createServices } = require(servicesPath);
    const ctx = makeContext(ROOT);

    if (WITH_TASKS) {
      const services = createServices(ctx);
      // Cost of the work P2 moved OFF the activation tick (measured directly).
      let t = process.hrtime.bigint();
      await services.understanding.ensureFresh();
      result.ensureFreshMs = +(Number(process.hrtime.bigint() - t) / 1e6).toFixed(2);
      t = process.hrtime.bigint();
      await services.mcp.connectAll();
      result.mcpConnectAllMs = +(Number(process.hrtime.bigint() - t) / 1e6).toFixed(2);
    }

    if (WITH_ACTIVATE) {
      const t = process.hrtime.bigint();
      await mod.activate(ctx);
      result.activateMs = +(Number(process.hrtime.bigint() - t) / 1e6).toFixed(2);
      // Give the deferred queue a tick, then let the process settle briefly.
      await new Promise((r) => setTimeout(r, 1));
    }
  }

  if (AS_JSON) {
    console.log(JSON.stringify(result));
  } else {
    console.log(`entry            : ${result.entry}`);
    console.log(`module load      : ${result.loadMs} ms  (runs: ${result.loadRunsMs.join(', ')})`);
    console.log(`modules loaded   : own ${result.modules.own} (${result.modules.ownKB} KB), deps ${result.modules.deps} (${result.modules.depsKB} KB)`);
    console.log(`exports activate : ${result.exportedActivate}`);
    if (result.servicesMs !== undefined) {
      console.log(`createServices   : ${result.servicesMs} ms`);
      console.log(`touch all (lazy): ${result.touchAllMs} ms`);
    }
    if (result.ensureFreshMs !== undefined) {
      console.log(`ensureFresh (P2 moved): ${result.ensureFreshMs} ms`);
      console.log(`connectAll  (P2 moved): ${result.mcpConnectAllMs} ms`);
    }
    if (result.activateMs !== undefined) {
      console.log(`activate() total : ${result.activateMs} ms`);
    }
    if (result.topModules.length) {
      console.log('largest modules  :');
      for (const m of result.topModules) console.log(`  ${String(m.KB).padStart(8)} KB  ${m.file}`);
    }
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
