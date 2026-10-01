import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

// Guardrail for the webview ↔ extension-host message contract.
//
// The contract used to live in TWO hand-maintained copies:
//   - src/shared/messages.ts            (consumed by the host, src/webview/ChatViewProvider.ts)
//   - src/webview-ui/src/types.ts       (consumed by the webview)
// with a "the webview project cannot resolve cross-project imports" comment
// justifying the duplication. That premise is false — the webview project sets
// rootDir to the repo root and already imports ../../shared/* modules — so the
// copies are re-exported from ONE source now. These tests pin that down and
// catch the drift that hid in the copies (members present in only one, and a
// message declared in the wrong direction).

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const SHARED_MESSAGES = path.join(REPO_ROOT, 'src', 'shared', 'messages.ts');
const SHARED_SESSION_RUN = path.join(REPO_ROOT, 'src', 'shared', 'sessionRun.ts');
const WEBVIEW_TYPES = path.join(REPO_ROOT, 'src', 'webview-ui', 'src', 'types.ts');

function read(p: string): string {
  return fs.readFileSync(p, 'utf8');
}

/** The `type: '...'` members of `export type <name> = ...` (attributed by the
 *  nearest preceding top-level `export type`). */
function unionMembers(src: string, name: string): string[] {
  const out: string[] = [];
  let cur: string | null = null;
  for (const line of src.split(/\r?\n/)) {
    const t = line.match(/^\s*export type (\w+) =/);
    if (t) { cur = t[1]; continue; }
    if (/^\s*export (interface|const|function) /.test(line)) { cur = null; continue; }
    if (cur === name) {
      const m = line.match(/\{\s*type:\s*'([^']+)'/);
      if (m) out.push(m[1]);
    }
  }
  return out;
}

function declaresInterfaceOrType(src: string, name: string): boolean {
  return new RegExp(`export (interface|type) ${name}\\b`).test(src);
}

/** Names NOT re-exported via `export type { ... } from '<fromPath>'`. */
function missingReExports(src: string, names: string[], fromPath: string): string[] {
  const found = new Set<string>();
  const re = /export type \{([^}]*)\} from '([^']+)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    if (m[2] === fromPath) {
      m[1].replace(/\/\/[^\r\n]*/g, '').split(',').map((s) => s.trim()).filter(Boolean).forEach((n) => found.add(n));
    }
  }
  return names.filter((n) => !found.has(n));
}

suite('Message contract — single source of truth', () => {
  test('the shared module declares both message unions', () => {
    const shared = read(SHARED_MESSAGES);
    assert.ok(declaresInterfaceOrType(shared, 'WebviewToExtensionMessage'), 'WebviewToExtensionMessage not declared in shared/messages.ts');
    assert.ok(declaresInterfaceOrType(shared, 'ExtensionToWebviewMessage'), 'ExtensionToWebviewMessage not declared in shared/messages.ts');
  });

  test('the webview re-exports both unions instead of hand-mirroring them', () => {
    const wv = read(WEBVIEW_TYPES);
    assert.ok(!declaresInterfaceOrType(wv, 'WebviewToExtensionMessage'), 'webview still declares WebviewToExtensionMessage locally');
    assert.ok(!declaresInterfaceOrType(wv, 'ExtensionToWebviewMessage'), 'webview still declares ExtensionToWebviewMessage locally');
    const missing = missingReExports(wv, ['WebviewToExtensionMessage', 'ExtensionToWebviewMessage'], '../../shared/messages');
    assert.deepStrictEqual(missing, [], `not re-exported from shared/messages: ${missing.join(', ')}`);
  });

  test('the webview re-exports the shared domain types (no local copies)', () => {
    const wv = read(WEBVIEW_TYPES);
    const fromMessages = [
      'ExtensionConfig', 'Session', 'TraceEntry', 'ToolCallInfo', 'StoredTurnTrace',
      'ImageAttachment', 'MessageContext', 'WorkItemSummary', 'WorkItemDetail',
      'WorkItemComment', 'WorkItemContext',
    ];
    const local = fromMessages.filter((n) => declaresInterfaceOrType(wv, n));
    assert.deepStrictEqual(local, [], `still locally declared in the webview: ${local.join(', ')}`);
    const missing = missingReExports(wv, fromMessages, '../../shared/messages');
    assert.deepStrictEqual(missing, [], `not re-exported from shared/messages: ${missing.join(', ')}`);
    const missingSR = missingReExports(wv, ['SessionRunInfo'], '../../shared/sessionRun');
    assert.deepStrictEqual(missingSR, [], 'SessionRunInfo not re-exported from shared/sessionRun');
  });

  test('ExtensionToWebviewMessage carries the host→webview messages 0.6.x added', () => {
    const e2w = unionMembers(read(SHARED_MESSAGES), 'ExtensionToWebviewMessage');
    for (const t of ['delegationSuggestion', 'steeringQueued', 'steeringApplied', 'sessionRunState', 'openProjectWizard']) {
      assert.ok(e2w.includes(t), `ExtensionToWebviewMessage is missing '${t}'`);
    }
  });

  test('WebviewToExtensionMessage only lists webview→host messages', () => {
    const w2e = unionMembers(read(SHARED_MESSAGES), 'WebviewToExtensionMessage');
    assert.ok(!w2e.includes('openProjectWizard'), "'openProjectWizard' is host→webview and must not be in WebviewToExtensionMessage");
    for (const t of [
      'confirmationResponse', 'getSkillCatalog', 'installSkill', 'uninstallSkill', 'enableSkill',
      'disableSkill', 'executeSkill', 'getSkillDetail', 'getRegistrySkills', 'installRegistrySkill', 'saveSvg',
    ]) {
      assert.ok(w2e.includes(t), `WebviewToExtensionMessage is missing '${t}'`);
    }
  });

  test('ExtensionConfig in the shared module is the complete settings snapshot', () => {
    const shared = read(SHARED_MESSAGES);
    for (const field of ['chatInputWhileBusy', 'chatSuggestDelegation', 'chatDensity']) {
      assert.ok(new RegExp(`\\b${field}\\??\\s*:`).test(shared), `ExtensionConfig is missing '${field}'`);
    }
  });

  test('sessionList carries the host-computed running badge field', () => {
    const m = read(SHARED_MESSAGES).match(/type: 'sessionList';([^}]*)\}/);
    assert.ok(m, 'sessionList member not found in shared/messages.ts');
    assert.ok(/running\??:/.test(m![1]), 'sessionList is missing the optional `running` badge field');
  });

  test('the stale "cannot resolve cross-project imports" premise is gone', () => {
    const wv = read(WEBVIEW_TYPES);
    assert.ok(!/cannot resolve/i.test(wv), 'webview types still claim cross-project imports cannot be resolved');
    assert.ok(!/cannot import/i.test(read(SHARED_SESSION_RUN)), 'sessionRun still claims the webview cannot import it');
  });
});
