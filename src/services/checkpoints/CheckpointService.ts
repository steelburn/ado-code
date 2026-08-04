import * as fs from 'fs';
import * as path from 'path';
import { CheckpointManifest, CheckpointDiff } from './types';

export class CheckpointService {
  private workspaceRoot: string;
  private checkpointsRoot: string;

  constructor(workspaceDir: string) {
    this.workspaceRoot = workspaceDir;
    this.checkpointsRoot = path.join(workspaceDir, '.ado-code', 'checkpoints');
  }

  /**
   * Save a checkpoint: read files from workspace, store base64 in JSON manifest.
   * Returns the checkpoint ID (timestamp string).
   */
  save(taskId: string, filePaths: string[]): string {
    const timestamp = Date.now();
    const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
    const id = `${timestamp}-${random}`;

    const files: Record<string, string> = {};
    for (const filePath of filePaths) {
      const absolutePath = path.join(this.workspaceRoot, filePath);
      if (fs.existsSync(absolutePath)) {
        const content = fs.readFileSync(absolutePath);
        files[filePath] = content.toString('base64');
      }
    }

    const manifest: CheckpointManifest = {
      id,
      taskId,
      timestamp,
      files,
    };

    const taskDir = this.getTaskDir(taskId);
    fs.mkdirSync(taskDir, { recursive: true });

    const manifestPath = path.join(taskDir, `${id}.json`);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    this.evictOld(taskDir);

    return id;
  }

  /**
   * Restore a checkpoint: read manifest, write files back to workspace.
   * Returns list of restored file paths.
   */
  restore(checkpointId: string, taskId: string): string[] {
    const manifest = this.readManifest(checkpointId, taskId);
    const restoredPaths: string[] = [];

    for (const [relPath, base64Content] of Object.entries(manifest.files)) {
      const absolutePath = path.join(this.workspaceRoot, relPath);
      const dir = path.dirname(absolutePath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(absolutePath, Buffer.from(base64Content, 'base64'));
      restoredPaths.push(relPath);
    }

    return restoredPaths;
  }

  /**
   * List all checkpoints for a task, sorted by timestamp descending.
   */
  listCheckpoints(taskId: string): CheckpointManifest[] {
    const taskDir = this.getTaskDir(taskId);
    if (!fs.existsSync(taskDir)) {
      return [];
    }

    const files = fs.readdirSync(taskDir)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        const content = fs.readFileSync(path.join(taskDir, f), 'utf8');
        return JSON.parse(content) as CheckpointManifest;
      });

    files.sort((a, b) => b.timestamp - a.timestamp);
    return files;
  }

  /**
   * Compare a checkpoint's saved content against current workspace files.
   */
  getDiff(checkpointId: string, taskId: string): CheckpointDiff[] {
    const manifest = this.readManifest(checkpointId, taskId);
    const diffs: CheckpointDiff[] = [];

    const savedPaths = new Set(Object.keys(manifest.files));

    // Check files that exist in the manifest
    for (const [relPath, base64Content] of Object.entries(manifest.files)) {
      const absolutePath = path.join(this.workspaceRoot, relPath);
      const savedContent = Buffer.from(base64Content, 'base64').toString('utf8');

      if (fs.existsSync(absolutePath)) {
        const currentContent = fs.readFileSync(absolutePath, 'utf8');
        diffs.push({
          filePath: relPath,
          status: savedContent === currentContent ? 'unchanged' : 'modified',
          before: savedContent,
          after: currentContent,
        });
      } else {
        diffs.push({
          filePath: relPath,
          status: 'removed',
          before: savedContent,
        });
      }
    }

    // Check files that exist in workspace but not in manifest (added since checkpoint)
    const allWorkspaceFiles = this.listWorkspaceFiles(this.workspaceRoot, '');
    for (const relPath of allWorkspaceFiles) {
      if (!savedPaths.has(relPath)) {
        const absolutePath = path.join(this.workspaceRoot, relPath);
        const currentContent = fs.readFileSync(absolutePath, 'utf8');
        diffs.push({
          filePath: relPath,
          status: 'added',
          after: currentContent,
        });
      }
    }

    return diffs;
  }

  /**
   * Delete a checkpoint manifest file.
   */
  deleteCheckpoint(checkpointId: string, taskId: string): void {
    const taskDir = this.getTaskDir(taskId);
    const manifestPath = path.join(taskDir, `${checkpointId}.json`);
    if (fs.existsSync(manifestPath)) {
      fs.unlinkSync(manifestPath);
    }
  }

  /**
   * Keep only the newest maxCount checkpoints, remove older ones.
   */
  private evictOld(taskDir: string, maxCount: number = 50): void {
    if (!fs.existsSync(taskDir)) {
      return;
    }

    const files = fs.readdirSync(taskDir)
      .filter(f => f.endsWith('.json'))
      .sort((a, b) => {
        // ID format: <timestamp>-<random>.json
        const tsA = parseInt(a.split('-')[0], 10);
        const tsB = parseInt(b.split('-')[0], 10);
        return tsB - tsA;
      });

    if (files.length > maxCount) {
      for (let i = maxCount; i < files.length; i++) {
        fs.unlinkSync(path.join(taskDir, files[i]));
      }
    }
  }

  /**
   * Read and parse a checkpoint manifest by ID and taskId.
   */
  private readManifest(id: string, taskId: string): CheckpointManifest {
    const taskDir = this.getTaskDir(taskId);
    const manifestPath = path.join(taskDir, `${id}.json`);
    if (!fs.existsSync(manifestPath)) {
      throw new Error(`Checkpoint ${id} not found for task ${taskId}`);
    }
    const content = fs.readFileSync(manifestPath, 'utf8');
    return JSON.parse(content) as CheckpointManifest;
  }

  private getTaskDir(taskId: string): string {
    return path.join(this.checkpointsRoot, taskId);
  }

  private listWorkspaceFiles(dir: string, prefix: string): string[] {
    const results: string[] = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;

      // Skip .ado-code directory and common ignore directories
      if (entry.name === '.ado-code' || entry.name === '.git' || entry.name === 'node_modules') {
        continue;
      }

      if (entry.isDirectory()) {
        results.push(...this.listWorkspaceFiles(path.join(dir, entry.name), relPath));
      } else {
        results.push(relPath);
      }
    }

    return results;
  }
}
