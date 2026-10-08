// Minimal headless `vscode` stub for running unit tests outside the extension
// host:
//
//   node node_modules/mocha/bin/mocha.js --ui tdd \
//     --require ./scripts/vscode-stub.js out/test/suite/**/*.test.js
//
// The real test host (`node out/test/runTest.js`) needs a VS Code download and
// a GUI; this lets the pure/shared suites run anywhere. To behave like the real
// module, `require('vscode')` returns one cached instance (so a test that spies
// on an API is seen by the code under test) and configuration `update()`s are
// observable by later `get()`s. Explicit shapes cover what the services touched
// by the startup path actually use (configuration,
// output channels, workspace folders); anything else falls through to a
// permissive proxy so that module-load-time access cannot explode. Mirrors the
// stub used by scripts/bench-startup.js.
'use strict';

const Module = require('module');
const nodePath = require('path');
const nodeFs = require('fs');

function generic(name) {
    const fn = function () { return generic(`${name}()`); };
    return new Proxy(fn, {
        get(_t, prop) {
            if (prop === 'then') { return undefined; }
            if (prop === Symbol.toPrimitive) { return () => name; }
            if (prop === 'toString') { return () => name; }
            if (prop === 'valueOf') { return () => name; }
            if (prop === 'fsPath' || prop === 'path' || prop === 'scheme') { return name; }
            return generic(`${name}.${String(prop)}`);
        },
        apply() { return generic(`${name}()`); },
        construct() { return generic(`new ${name}()`); },
    });
}

function makeVscodeStub() {
    class Disposable {
        constructor(fn) { this.dispose = fn || (() => { /* noop */ }); }
        static from() { return new Disposable(); }
    }

    class EventEmitter {
        constructor() {
            this._listeners = new Set();
            this.event = (listener, thisArgs, disposables) => {
                const bound = thisArgs ? listener.bind(thisArgs) : listener;
                this._listeners.add(bound);
                const subscription = new Disposable(() => { this._listeners.delete(bound); });
                if (Array.isArray(disposables)) { disposables.push(subscription); }
                return subscription;
            };
        }
        fire(value) {
            for (const listener of Array.from(this._listeners)) { listener(value); }
        }
        dispose() { this._listeners.clear(); }
    }

    // Minimal Uri with a real `fsPath`/`toString()`, enough for the panels that
    // join an extension URI and hand it to `asWebviewUri`.
    class Uri {
        constructor(fsPath, scheme) {
            this.fsPath = fsPath;
            this.scheme = scheme || 'file';
            this.authority = '';
            this.path = String(fsPath).replace(/\\/g, '/');
            this.query = '';
            this.fragment = '';
        }
        static file(fsPath) { return new Uri(String(fsPath), 'file'); }
        static parse(value) {
            const text = String(value);
            const match = /^(?:([a-zA-Z][\w+.-]*):)?\/\/([^/]*)(.*)$/.exec(text);
            if (match && match[3]) { return new Uri(match[3], match[1] || 'file'); }
            return new Uri(text, 'file');
        }
        static joinPath(base, ...parts) {
            const basePath = base && base.fsPath ? base.fsPath : String(base);
            const scheme = base && base.scheme ? base.scheme : 'file';
            return new Uri(nodePath.join(basePath, ...parts.map(String)), scheme);
        }
        toString() {
            const p = this.path.startsWith('/') ? this.path : `/${this.path}`;
            return `${this.scheme}://${this.authority}${p}`;
        }
        with(change) {
            const next = change || {};
            const uri = new Uri(next.fsPath || this.fsPath, next.scheme || this.scheme);
            if (next.path !== undefined) { uri.path = next.path; }
            if (next.authority !== undefined) { uri.authority = next.authority; }
            if (next.query !== undefined) { uri.query = next.query; }
            if (next.fragment !== undefined) { uri.fragment = next.fragment; }
            return uri;
        }
    }

    // Real tree-item base class: the derived nodes in src/webview write to
    // `label`/`id`/`checkboxState`/… and the tests read them back, so plain
    // own properties must survive (the generic proxy swallowed those writes).
    class TreeItem {
        constructor(label, collapsibleState) {
            this.label = label;
            this.collapsibleState = collapsibleState;
            this.id = undefined;
            this.iconPath = undefined;
            this.contextValue = undefined;
            this.tooltip = undefined;
            this.description = undefined;
            this.resourceUri = undefined;
            this.command = undefined;
            this.checkboxState = undefined;
            this.accessibilityInformation = undefined;
        }
    }

    class MarkdownString {
        constructor(value) {
            this.value = value || '';
            this.isTrusted = undefined;
            this.supportThemeIcons = undefined;
        }
        appendText(value) { this.value += value; return this; }
        appendMarkdown(value) { this.value += value; return this; }
        appendCodeblock(value, language) {
            this.value += `\n\`\`\`${language || ''}\n${value}\n\`\`\`\n`;
            return this;
        }
    }

    const TreeItemCheckboxState = { Unchecked: 0, Checked: 1 };

    // Mutable configuration backing `workspace.getConfiguration(section)`. A
    // value written by `update(key, value)` is returned by a later `get(key)`
    // (keyed per section:key); `update(key, undefined)` clears it again.
    const configStore = new Map();
    const makeConfiguration = (section) => {
        const keyOf = (k) => `${section || ''}:${k}`;
        return {
            get: (k, defaultValue) => (configStore.has(keyOf(k)) ? configStore.get(keyOf(k)) : defaultValue),
            has: (k) => configStore.has(keyOf(k)),
            inspect: (k) => (configStore.has(keyOf(k)) ? { key: k, globalValue: configStore.get(keyOf(k)) } : undefined),
            update: async (k, value) => {
                if (value === undefined) { configStore.delete(keyOf(k)); }
                else { configStore.set(keyOf(k), value); }
            },
        };
    };

    const outputChannel = {
        name: 'test',
        append: () => { /* noop */ },
        appendLine: () => { /* noop */ },
        clear: () => { /* noop */ },
        show: () => { /* noop */ },
        hide: () => { /* noop */ },
        dispose: () => { /* noop */ },
    };

    const workspace = {
        getConfiguration: (section) => makeConfiguration(section),
        workspaceFolders: undefined,
        name: 'ado-code-test',
        textDocuments: [],
        onDidChangeConfiguration: () => new Disposable(),
        onDidChangeWorkspaceFolders: () => new Disposable(),
        onDidSaveTextDocument: () => new Disposable(),
        onDidOpenTextDocument: () => new Disposable(),
        openTextDocument: async () => generic('TextDocument'),
        asRelativePath: (uriOrPath) => {
            const p = uriOrPath && uriOrPath.fsPath ? uriOrPath.fsPath : String(uriOrPath);
            return p;
        },
        // Backed by the real filesystem so tests can write then read back.
        fs: {
            readFile: async (uri) => nodeFs.promises.readFile(uri.fsPath),
            writeFile: async (uri, content) => { await nodeFs.promises.writeFile(uri.fsPath, content); },
            stat: async (uri) => {
                const st = await nodeFs.promises.stat(uri.fsPath);
                return { type: st.isDirectory() ? 2 : 1, ctime: st.ctimeMs, mtime: st.mtimeMs, size: st.size };
            },
            createDirectory: async (uri) => { await nodeFs.promises.mkdir(uri.fsPath, { recursive: true }); },
            readDirectory: async (uri) => {
                const entries = await nodeFs.promises.readdir(uri.fsPath, { withFileTypes: true });
                return entries.map((e) => [e.name, e.isDirectory() ? 2 : 1]);
            },
            delete: async (uri, options) => {
                await nodeFs.promises.rm(uri.fsPath, { recursive: !!(options && options.recursive), force: true });
            },
        },
    };

    const windowShape = {
        createOutputChannel: () => outputChannel,
        createStatusBarItem: () => ({
            text: '', tooltip: '', command: undefined,
            show: () => { /* noop */ }, hide: () => { /* noop */ }, dispose: () => { /* noop */ },
        }),
        createTreeView: () => ({ dispose: () => { /* noop */ } }),
        registerWebviewViewProvider: () => new Disposable(),
        registerWebviewPanelSerializer: () => new Disposable(),
        createWebviewPanel: (viewType, title, column, options) => ({
            viewType, title, viewColumn: column, options,
            visible: true,
            iconPath: undefined,
            webview: {
                options: {}, html: '', cspSource: 'stub-csp',
                postMessage: () => Promise.resolve(true),
                asWebviewUri: (u) => u,
                onDidReceiveMessage: () => new Disposable(),
            },
            reveal: () => { /* noop */ },
            dispose: () => { /* noop */ },
            onDidDispose: () => new Disposable(),
            onDidChangeViewState: () => new Disposable(),
        }),
        registerTreeDataProvider: () => new Disposable(),
        showInformationMessage: async () => undefined,
        showWarningMessage: async () => undefined,
        showErrorMessage: async () => undefined,
        showQuickPick: async () => undefined,
        showInputBox: async () => undefined,
        showOpenDialog: async () => undefined,
        withProgress: async (_options, task) => task({ report: () => { /* noop */ } }, generic('CancellationToken')),
        activeTextEditor: undefined,
        visibleTextEditors: [],
        onDidChangeActiveTextEditor: () => new Disposable(),
        onDidChangeTextEditorSelection: () => new Disposable(),
        tabGroups: { all: [] },
        terminals: [],
    };

    const api = {
        Disposable,
        EventEmitter,
        workspace,
        window: new Proxy(windowShape, {
            get(target, prop) {
                return prop in target ? target[prop] : generic(`window.${String(prop)}`);
            },
        }),
        commands: {
            registerCommand: () => new Disposable(),
            executeCommand: async () => undefined,
            getCommands: async () => [],
        },
        env: {
            appName: 'test',
            machineId: 'test',
            language: 'en',
            openExternal: async () => true,
            clipboard: { writeText: async () => { /* noop */ }, readText: async () => '' },
        },
        Uri,
        version: '0.0.0-test',
        ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
        ViewColumn: { Active: -1, One: 1, Two: 2, Three: 3 },
        ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
        TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
        TreeItemCheckboxState,
        TreeItem,
        MarkdownString,
        StatusBarAlignment: { Left: 1, Right: 2 },
        ExtensionMode: { Production: 1, Development: 2, Test: 3 },
        ThemeIcon: class ThemeIcon { constructor(id, color) { this.id = id; this.color = color; } },
        ThemeColor: class ThemeColor { constructor(id) { this.id = id; } },
        extensions: { getExtension: () => undefined, all: [] },
        languages: { registerCodeLensProvider: () => new Disposable() },
        lm: {},
    };

    return new Proxy(api, {
        get(target, prop) {
            return prop in target ? target[prop] : generic(`vscode.${String(prop)}`);
        },
    });
}

let cachedStub;

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
    // Singleton, like the real module: a per-require stub would hide test spies
    // (e.g. `vscode.commands.executeCommand`) from the code under test.
    if (request === 'vscode') { return cachedStub || (cachedStub = makeVscodeStub()); }
    return originalLoad.apply(this, arguments);
};

module.exports = { makeVscodeStub };
