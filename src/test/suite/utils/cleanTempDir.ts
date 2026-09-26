import * as cp from 'child_process';
import * as fs from 'fs';

/**
 * Safely removes a temporary directory on Windows.
 * Steps:
 * 1. Run `git gc --prune=now` inside the directory to allow Git to release handles.
 * 2. Clear read‑only attributes (attrib -R /S /D) – a no‑op on non‑Windows platforms.
 * 3. Remove recursively with `fs.rmSync`, swallowing any error after logging.
 */
export function cleanTempDir(tmpDir: string): void {
  try {
    // Step 1 – run git garbage collection.
    cp.execSync('git gc --prune=now', { cwd: tmpDir, stdio: 'ignore' });
  } catch {}

  if (process.platform === 'win32') {
    try {
      // Step 2 – clear read‑only flag recursively.
      cp.execSync(`attrib -R /S /D "${tmpDir}\*"`, { stdio: 'ignore' });
    } catch {}
  }

  try {
    // Step 3 – final removal.
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (e) {
    console.warn('cleanTempDir warning:', (e as any).message);
  }
}
