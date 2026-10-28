import * as vscode from 'vscode';
import {
  BinarySaveRequest,
  MAX_SAVE_BYTES,
  describeBytes,
  planBinarySave,
} from '../shared/binaryExport';

/**
 * The host half of the `saveBinary` bridge: everything the webview renders
 * (DOCX, XLSX, rasterised diagrams, evidence images) is posted as base64 and
 * written here through a native save dialog.
 *
 * This generalises `svgExport.promptAndSaveSvg`, which stays for the existing
 * `saveSvg` message. Every decision worth testing lives in
 * `src/shared/binaryExport.ts`; this module is dialog + write + notification.
 */

export type SaveBinaryFailure = 'invalid' | 'cancelled' | 'error';

export interface SaveBinaryOutcome {
  saved: boolean;
  filePath?: string;
  reason?: SaveBinaryFailure;
  message?: string;
}

function relativeLabel(uri: vscode.Uri): string {
  try {
    return vscode.workspace.asRelativePath(uri, false);
  } catch {
    return uri.fsPath;
  }
}

/**
 * Prompts for a destination and writes the decoded bytes.
 *
 * Never throws: a cancelled dialog is a normal outcome (`saved: false`), and a
 * rejected payload or failed write surfaces as a single error notification.
 */
export async function promptAndSaveBinary(
  request: BinarySaveRequest,
): Promise<SaveBinaryOutcome> {
  const planned = planBinarySave(request);
  if (!planned.ok) {
    vscode.window.showErrorMessage(planned.message);
    return { saved: false, reason: 'invalid', message: planned.message };
  }

  const { plan } = planned;
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  const baseDir = plan.defaultDir && root
    ? vscode.Uri.joinPath(root, plan.defaultDir)
    : root;
  const defaultUri = baseDir
    ? vscode.Uri.joinPath(baseDir, plan.fileName)
    : undefined;

  const target = await vscode.window.showSaveDialog({
    saveLabel: 'Save',
    filters: plan.filters,
    defaultUri,
  });
  if (!target) {
    return { saved: false, reason: 'cancelled' };
  }

  try {
    const bytes = Buffer.from(plan.payload, 'base64');
    // Belt-and-braces: the planner already bounded the *declared* size, but the
    // decoded buffer is the number that actually reaches the disk.
    if (bytes.length > MAX_SAVE_BYTES) {
      const message = `Export is ${describeBytes(bytes.length)}, above the save limit — nothing was written.`;
      vscode.window.showErrorMessage(message);
      return { saved: false, reason: 'invalid', message };
    }
    // `workspace.fs.writeFile` does not create parents, so a default folder like
    // `export/out` or `assets/evidence` fails on a fresh project. `createDirectory`
    // is recursive and idempotent.
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(target, '..'));
    await vscode.workspace.fs.writeFile(target, bytes);
    const action = await vscode.window.showInformationMessage(
      `Saved ${relativeLabel(target)} (${describeBytes(bytes.length)})`,
      'Open',
    );
    if (action === 'Open') {
      await vscode.commands.executeCommand('vscode.open', target);
    }
    return { saved: true, filePath: target.fsPath };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const message = `Failed to save export: ${detail}`;
    vscode.window.showErrorMessage(message);
    return { saved: false, reason: 'error', message };
  }
}
