import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { promptAndSaveBinary } from '../../../webview/saveBinary';
import { makeScratchDir } from '../utils/scratchDir';

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** Two-byte payload with a known decode: 'UEsDBA==' -> PK\x03\x04. */
const PAYLOAD = 'UEsDBA==';

/** Uri.file() may re-case the Windows drive letter; compare path-insensitively. */
const norm = (p: string): string => p.replace(/\\/g, "/").toLowerCase();
const PAYLOAD_BYTES = Buffer.from(PAYLOAD, 'base64');

interface Patches {
  dialogs: Array<{ filters?: Record<string, string[]>; defaultUri?: vscode.Uri }>;
  errors: string[];
  infos: string[];
  opens: unknown[];
  savedTo?: vscode.Uri;
}

/** Snapshot taken once so every test starts from unpatched APIs. */
let originals: {
  win: Record<string, unknown>;
  exec: unknown;
  folders: PropertyDescriptor | undefined;
};


function installHarness(targetFolder: string, options: { cancel?: boolean; infoAction?: string; writeFails?: boolean } = {}): Patches {
  const patches: Patches = { dialogs: [], errors: [], infos: [], opens: [] };
  const win = vscode.window as any;
  const workspace = vscode.workspace as any;

  // The real host may define this as a non-configurable getter; fall back to a
  // plain assignment rather than failing the test on the harness.
  try {
    Object.defineProperty(workspace, 'workspaceFolders', {
      value: [{ uri: vscode.Uri.file(targetFolder), name: 'ws', index: 0 }],
      writable: true,
      configurable: true,
    });
  } catch {
    setProp(workspace, 'workspaceFolders', [{ uri: vscode.Uri.file(targetFolder), name: 'ws', index: 0 }]);
  }

  win.showSaveDialog = async (opts: any) => {
    patches.dialogs.push({ filters: opts?.filters, defaultUri: opts?.defaultUri });
    return options.cancel ? undefined : opts?.defaultUri;
  };
  win.showInformationMessage = async (msg: string, ...actions: string[]) => {
    patches.infos.push(msg);
    return actions.includes(options.infoAction ?? '') ? options.infoAction : undefined;
  };
  win.showErrorMessage = async (msg: string) => {
    patches.errors.push(msg);
    return undefined;
  };
  (vscode.commands as any).executeCommand = async (command: string, arg: unknown) => {
    patches.opens.push({ command, arg });
    return undefined;
  };
  if (options.writeFails) {
    // The real host defines workspace.fs.writeFile non-configurable, so the
    // write cannot be stubbed — make the chosen destination a directory and
    // let the genuine EISDIR come back through the error path instead.
    const dialog = win.showSaveDialog;
    win.showSaveDialog = async (opts: any) => {
      const chosen = await dialog(opts);
      if (chosen) {
        fs.mkdirSync(chosen.fsPath, { recursive: true });
      }
      return chosen;
    };
  }
  return patches;
}

function makeTempDir(): string {
  return makeScratchDir('ado-savebinary-');
}

function cleanup(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows can hold a handle briefly; the OS temp cleaner handles the rest.
  }
}


/**
 * Assigns a VS Code API member. The real extension host defines several of
 * these (notably workspace.fs.writeFile) as read-only, so a plain assignment
 * throws in the Electron harness even though the headless stub allows it.
 */
function setProp(target: any, key: string, value: unknown): void {
  try {
    target[key] = value;
  } catch {
    Object.defineProperty(target, key, { value, writable: true, configurable: true });
  }
}

/**
 * Restores a member to its exact prior state, including "was never defined".
 *
 * `workspaceFolders` is patched to a temp folder per test; leaving it pointing at
 * a directory that `cleanup()` then deletes leaks into every later suite that
 * derives a path from the workspace (sessionScoping failed 4 tests that way).
 */
function restoreProp(target: any, key: string, descriptor: PropertyDescriptor | undefined): void {
  try {
    if (descriptor) Object.defineProperty(target, key, descriptor);
    else delete target[key];
  } catch {
    // Non-configurable in the real host: leave its previous value in place.
  }
}
suite('saveBinary — host bridge', () => {

  suiteSetup(() => {
    const win = vscode.window as any;
    originals = {
      win: {
        showSaveDialog: win.showSaveDialog,
        showInformationMessage: win.showInformationMessage,
        showErrorMessage: win.showErrorMessage,
      },
      exec: (vscode.commands as any).executeCommand,
      folders: Object.getOwnPropertyDescriptor(vscode.workspace, 'workspaceFolders'),
    };
  });

  // Restoring before each test (not after) keeps a failure in one test from
  // poisoning the next — that leak is what made two assertions fail spuriously.
  setup(() => {
    const win = vscode.window as any;
    win.showSaveDialog = originals.win.showSaveDialog;
    win.showInformationMessage = originals.win.showInformationMessage;
    win.showErrorMessage = originals.win.showErrorMessage;
    setProp(vscode.commands, 'executeCommand', originals.exec);
    restoreProp(vscode.workspace, 'workspaceFolders', originals.folders);
  });
  test('writes the decoded bytes to the chosen destination', async () => {
    const dir = makeTempDir();
    try {
      const patches = installHarness(dir);
      const outcome = await promptAndSaveBinary({
        content: PAYLOAD,
        mime: DOCX,
        defaultName: 'report',
        defaultDir: 'export/out',
      });

      assert.strictEqual(outcome.saved, true);
      const expected = path.join(dir, 'export', 'out', 'report.docx');
      assert.strictEqual(norm(outcome.filePath as string), norm(expected));
      assert.ok(fs.existsSync(expected), 'file was not written');
      assert.deepStrictEqual(fs.readFileSync(expected), PAYLOAD_BYTES, 'bytes differ from the payload');
      assert.strictEqual(patches.infos.length, 1);
      assert.ok(/Saved /.test(patches.infos[0]), patches.infos[0]);
      assert.deepStrictEqual(patches.errors, []);
    } finally {
      cleanup(dir);
    }
  });

  test('starts the dialog on the requested sub-folder of the workspace', async () => {
    const dir = makeTempDir();
    try {
      const patches = installHarness(dir);
      await promptAndSaveBinary({
        content: PAYLOAD,
        mime: 'image/png',
        defaultName: 'EVD-001',
        defaultDir: 'assets/evidence',
      });
      assert.strictEqual(patches.dialogs.length, 1);
      const defaultUri = patches.dialogs[0].defaultUri;
      assert.ok(defaultUri, 'dialog got no defaultUri');
      assert.ok(
        defaultUri!.fsPath.endsWith(path.join('assets', 'evidence', 'EVD-001.png')),
        defaultUri!.fsPath,
      );
    } finally {
      cleanup(dir);
    }
  });

  test('passes derived filters through to the dialog', async () => {
    const dir = makeTempDir();
    try {
      const patches = installHarness(dir);
      await promptAndSaveBinary({ content: PAYLOAD, mime: DOCX, defaultName: 'report' });
      assert.deepStrictEqual(patches.dialogs[0].filters, {
        'Word document': ['docx'],
        'All files': ['*'],
      });
    } finally {
      cleanup(dir);
    }
  });

  test('explicit filters are honoured', async () => {
    const dir = makeTempDir();
    try {
      const patches = installHarness(dir);
      await promptAndSaveBinary({
        content: PAYLOAD,
        mime: 'text/csv',
        defaultName: 'rtm',
        filters: { 'Register (CSV)': ['csv'] },
      });
      assert.deepStrictEqual(patches.dialogs[0].filters, { 'Register (CSV)': ['csv'] });
    } finally {
      cleanup(dir);
    }
  });

  test('cancelling the dialog writes nothing and reports cancellation', async () => {
    const dir = makeTempDir();
    try {
      const patches = installHarness(dir, { cancel: true });
      const outcome = await promptAndSaveBinary({ content: PAYLOAD, mime: DOCX, defaultName: 'report' });
      assert.strictEqual(outcome.saved, false);
      assert.strictEqual(outcome.reason, 'cancelled');
      assert.deepStrictEqual(patches.errors, [], 'cancelling is not an error');
      assert.deepStrictEqual(fs.readdirSync(dir), [], 'nothing should have been written');
    } finally {
      cleanup(dir);
    }
  });

  test('an invalid payload is refused before the dialog opens', async () => {
    const dir = makeTempDir();
    try {
      const patches = installHarness(dir);
      const outcome = await promptAndSaveBinary({ content: 'not base64!!', mime: DOCX, defaultName: 'report' });
      assert.strictEqual(outcome.saved, false);
      assert.strictEqual(outcome.reason, 'invalid');
      assert.strictEqual(patches.dialogs.length, 0, 'the user should not be asked where to save a rejected payload');
      assert.strictEqual(patches.errors.length, 1);
    } finally {
      cleanup(dir);
    }
  });

  test('a failed write surfaces as an error rather than a crash', async () => {
    const dir = makeTempDir();
    try {
      const patches = installHarness(dir, { writeFails: true });
      const outcome = await promptAndSaveBinary({ content: PAYLOAD, mime: DOCX, defaultName: 'report' });
      assert.strictEqual(outcome.saved, false);
      assert.strictEqual(outcome.reason, 'error');
      assert.ok(outcome.message && /Failed to save export/.test(outcome.message), outcome.message);
      assert.strictEqual(patches.errors.length, 1);
    } finally {
      cleanup(dir);
    }
  });

  test('the confirmation offers Open, which reveals the written file', async () => {
    const dir = makeTempDir();
    try {
      const patches = installHarness(dir, { infoAction: 'Open' });
      const outcome = await promptAndSaveBinary({ content: PAYLOAD, mime: DOCX, defaultName: 'report' });
      assert.strictEqual(outcome.saved, true);
      assert.strictEqual(patches.opens.length, 1);
      assert.strictEqual((patches.opens[0] as any).command, 'vscode.open');
    } finally {
      cleanup(dir);
    }
  });

  test('a data: URI payload is written as bare bytes', async () => {
    const dir = makeTempDir();
    try {
      installHarness(dir);
      await promptAndSaveBinary({
        content: `data:image/png;base64,${PAYLOAD}`,
        mime: 'image/png',
        defaultName: 'shot',
      });
      const written = fs.readFileSync(path.join(dir, 'shot.png'));
      assert.deepStrictEqual(written, PAYLOAD_BYTES, 'the data: prefix leaked into the file');
    } finally {
      cleanup(dir);
    }
  });

  suiteTeardown(() => {
    // Leave the process exactly as it was found for any suite that follows.
    restoreProp(vscode.workspace, 'workspaceFolders', originals.folders);
  });

  test('a traversal defaultDir cannot escape the workspace', async () => {
    const dir = makeTempDir();
    try {
      const patches = installHarness(dir);
      await promptAndSaveBinary({
        content: PAYLOAD,
        mime: DOCX,
        defaultName: 'report',
        defaultDir: '../../../escape',
      });
      const fsPath = patches.dialogs[0].defaultUri!.fsPath;
      assert.ok(norm(fsPath).startsWith(norm(dir)), `dialog escaped the workspace: ${fsPath}`);
      assert.ok(fsPath.endsWith('report.docx'), fsPath);
    } finally {
      cleanup(dir);
    }
  });
});
