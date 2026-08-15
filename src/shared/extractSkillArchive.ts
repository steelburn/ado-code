/**
 * extractSkillArchive — Extract .tar.gz or .zip skill packages.
 *
 * Returns the path to a temp directory containing the extracted contents.
 * The caller is responsible for cleaning up the temp directory.
 *
 * Uses system `tar` and `unzip` commands via child_process (no runtime deps).
 */

import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const exec = (cmd: string, opts?: cp.ExecOptions) =>
  new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    cp.exec(cmd, { timeout: 30_000, maxBuffer: 50 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });

export interface ExtractResult {
  /** Path to the extracted directory */
  dir: string;
  /** Format detected */
  format: 'tar.gz' | 'zip';
}

/** Detect archive format from file path. */
export function detectArchiveFormat(filePath: string): 'tar.gz' | 'zip' | null {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) return 'tar.gz';
  if (lower.endsWith('.zip')) return 'zip';
  return null;
}

/**
 * Extract an archive to a temp directory.
 * @returns ExtractResult with the temp dir path.
 */
export async function extractSkillArchive(archivePath: string): Promise<ExtractResult> {
  const format = detectArchiveFormat(archivePath);
  if (!format) {
    throw new Error(`Unsupported archive format: ${path.basename(archivePath)}. Use .tar.gz, .tgz, or .zip`);
  }

  if (!fs.existsSync(archivePath)) {
    throw new Error(`Archive not found: ${archivePath}`);
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ado-skill-'));

  try {
    if (format === 'tar.gz') {
      await exec(`tar -xzf "${archivePath}" -C "${tmpDir}"`);
    } else {
      await exec(`unzip -q "${archivePath}" -d "${tmpDir}"`);
    }
  } catch (err: any) {
    // Clean up on failure
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    throw new Error(`Failed to extract ${format} archive: ${err.message || String(err)}`);
  }

  return { dir: tmpDir, format };
}

/**
 * Find SKILL.md inside an extracted directory.
 * Looks for SKILL.md or skill.md (case-insensitive) at the root or one level deep.
 */
export function findSkillMd(dir: string): string | null {
  // Check root
  const rootNames = ['SKILL.md', 'skill.md', 'Skill.md'];
  for (const name of rootNames) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }

  // Check one level deep (e.g., extracted repo/my-skill/SKILL.md)
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      for (const name of rootNames) {
        const p = path.join(dir, entry.name, name);
        if (fs.existsSync(p)) return p;
      }
    }
  }

  return null;
}

/**
 * Find a .json skill file inside an extracted directory.
 * Looks for any .json file at the root or one level deep.
 */
export function findSkillJson(dir: string): string | null {
  // Check root for .json files
  const rootEntries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of rootEntries) {
    if (entry.isFile() && entry.name.endsWith('.json') && !entry.name.startsWith('.')) {
      return path.join(dir, entry.name);
    }
  }

  // Check one level deep
  for (const entry of rootEntries) {
    if (entry.isDirectory()) {
      const subEntries = fs.readdirSync(path.join(dir, entry.name), { withFileTypes: true });
      for (const sub of subEntries) {
        if (sub.isFile() && sub.name.endsWith('.json') && !sub.name.startsWith('.')) {
          return path.join(dir, entry.name, sub.name);
        }
      }
    }
  }

  return null;
}

/** Recursively collect all files in a directory. */
export function collectFiles(dir: string, base: string = dir): string[] {
  const results: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectFiles(full, base));
    } else {
      results.push(path.relative(base, full));
    }
  }
  return results;
}

/** Clean up a temp directory (best-effort). */
export function cleanupTempDir(dir: string): void {
  try {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch {
    // Best effort — temp dirs get cleaned by OS eventually
  }
}
