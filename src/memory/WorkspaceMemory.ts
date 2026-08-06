import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { logger } from '../services/logger';

/**
 * WorkspaceMemory provides persistent key-value storage scoped to the workspace.
 * Files are stored under `<workspace>/.ado-code/memory/` as JSON files.
 *
 * Designed to be used by the LLM agent to remember project-specific context
 * across conversations (e.g. conventions, decisions, temporary notes).
 */
export class WorkspaceMemory {
  private workspaceRoot: string;
  private memoryDir: string;
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  /** Fires after any mutation (write, delete). */
  readonly onDidChange = this._onDidChange.event;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
    this.memoryDir = path.join(workspaceRoot, '.ado-code', 'memory');
  }

  /**
   * Initialize the memory directory. Idempotent — safe to call multiple times.
   */
  init(): void {
    fs.mkdirSync(this.memoryDir, { recursive: true });
  }

  /**
   * Read a memory entry by key. Returns the stored string value, or null if
   * the key does not exist.
   */
  read(key: string): string | null {
    const filePath = this.getFilePath(key);
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const content = fs.readFileSync(filePath, 'utf8');
    return content;
  }

  /**
   * Write (or overwrite) a memory entry. Creates the memory directory if needed.
   */
  write(key: string, value: string): void {
    logger.info('WorkspaceMemory: write "' + key + '"');
    this.init();
    const filePath = this.getFilePath(key);
    fs.writeFileSync(filePath, value, 'utf8');
    this._onDidChange.fire();
  }

  /**
   * Delete a memory entry by key. Returns true if the key existed and was
   * deleted, false if the key did not exist.
   */
  delete(key: string): boolean {
    logger.info('WorkspaceMemory: deleted "' + key + '"');
    const filePath = this.getFilePath(key);
    if (!fs.existsSync(filePath)) {
      return false;
    }
    fs.unlinkSync(filePath);
    this._onDidChange.fire();
    return true;
  }

  /**
   * List all memory keys, sorted alphabetically.
   */
  list(): string[] {
    if (!fs.existsSync(this.memoryDir)) {
      return [];
    }
    const entries = fs.readdirSync(this.memoryDir, { withFileTypes: true });
    return entries
      .filter(e => e.isFile() && e.name.endsWith('.md'))
      .map(e => e.name.replace(/\.md$/, ''))
      .sort();
  }

  /**
   * Format all memory entries as a markdown string suitable for injection into
   * an LLM system prompt. Returns an empty string if there are no entries.
   */
  toPromptString(): string {
    const keys = this.list();
    if (keys.length === 0) {
      return '';
    }

    const lines: string[] = ['## Workspace Memory', ''];
    for (const key of keys) {
      const value = this.read(key);
      lines.push(`### ${key}`);
      lines.push('');
      lines.push(value ?? '');
      lines.push('');
    }
    return lines.join('\n');
  }

  /**
   * Get the absolute path to the memory directory.
   */
  getDir(): string {
    return this.memoryDir;
  }

  /**
   * Compute the filesystem path for a given key. Keys are sanitized to
   * prevent path traversal.
   */
  private getFilePath(key: string): string {
    // Strip any directory separators to prevent path traversal
    const sanitized = key.replace(/[/\\]/g, '_');
    return path.join(this.memoryDir, `${sanitized}.md`);
  }
}
