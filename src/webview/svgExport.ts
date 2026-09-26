import * as vscode from 'vscode';

/**
 * Ensures the SVG string has a standard XML header for saving to disk.
 */
export function ensureXmlDeclaration(content: string): string {
  const trimmed = content.trim();
  if (trimmed.startsWith('<?xml')) {
    return trimmed;
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n${trimmed}`;
}

/**
 * Prompts the user with a VS Code save dialog and saves SVG content to the chosen file.
 */
export async function promptAndSaveSvg(content: string, defaultName = 'diagram.svg'): Promise<boolean> {
  try {
    const filename = defaultName.toLowerCase().endsWith('.svg') ? defaultName : `${defaultName}.svg`;
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
    const defaultUri = workspaceFolder ? vscode.Uri.joinPath(workspaceFolder, filename) : vscode.Uri.file(filename);

    const uri = await vscode.window.showSaveDialog({
      defaultUri,
      filters: { 'SVG Image': ['svg'] },
    });

    if (!uri) {
      return false; // User cancelled
    }

    const fileContent = ensureXmlDeclaration(content);
    const encoder = new TextEncoder();
    await vscode.workspace.fs.writeFile(uri, encoder.encode(fileContent));
    vscode.window.showInformationMessage(`Diagram saved to ${vscode.workspace.asRelativePath(uri)}`);
    return true;
  } catch (err) {
    vscode.window.showErrorMessage(`Failed to save diagram: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}
