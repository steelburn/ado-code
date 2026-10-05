// Minimal headless `vscode` stub for running unit tests outside the extension
// host:
//
//   node node_modules/mocha/bin/mocha.js --ui tdd \
//     --require ./scripts/vscode-stub.js out/test/suite/**/*.test.js
//
// The real test host (`node out/test/runTest.js`) needs a VS Code download and
// a GUI; this lets the pure/shared suites run anywhere. Explicit shapes cover
// what the services touched by the startup path actually use (configuration,
// output channels, workspace folders); anything else falls through to a
// permissive proxy so that module-load-time access cannot explode. Mirrors the
// stub used by scripts/bench-startup.js.
'use strict';

const Module = require('module');

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
        constructor() { this.event = () => new Disposable(); }
        fire() { /* noop */ }
        dispose() { /* noop */ }
    }

    const configuration = {
        get: (_key, defaultValue) => defaultValue,
        has: () => false,
        inspect: () => undefined,
        update: async () => { /* noop */ },
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
        getConfiguration: () => configuration,
        workspaceFolders: undefined,
        name: 'ado-code-test',
        textDocuments: [],
        onDidChangeConfiguration: () => new Disposable(),
        onDidChangeWorkspaceFolders: () => new Disposable(),
        onDidSaveTextDocument: () => new Disposable(),
        onDidOpenTextDocument: () => new Disposable(),
        openTextDocument: async () => generic('TextDocument'),
        fs: {
            readFile: async () => new Uint8Array(),
            writeFile: async () => { /* noop */ },
            stat: async () => generic('FileStat'),
            createDirectory: async () => { /* noop */ },
            readDirectory: async () => [],
            delete: async () => { /* noop */ },
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
        Uri: {
            file: (fsPath) => ({ fsPath, scheme: 'file', toString: () => `file://${fsPath}` }),
            parse: (value) => ({ fsPath: String(value).replace(/^file:\/\//, ''), scheme: 'file' }),
            joinPath: (base, ...parts) => ({ fsPath: [base.fsPath ?? base, ...parts].join('/'), scheme: 'file' }),
        },
        version: '0.0.0-test',
        ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
        ViewColumn: { Active: -1, One: 1, Two: 2, Three: 3 },
        ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
        TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
        StatusBarAlignment: { Left: 1, Right: 2 },
        ExtensionMode: { Production: 1, Development: 2, Test: 3 },
        ThemeIcon: class ThemeIcon { constructor(id) { this.id = id; } },
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

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'vscode') { return makeVscodeStub(); }
    return originalLoad.apply(this, arguments);
};

module.exports = { makeVscodeStub };
