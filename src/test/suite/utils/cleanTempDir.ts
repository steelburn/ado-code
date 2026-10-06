import * as cp from 'child_process';
import * as fs from 'fs';

/**
 * Safely removes a temporary directory on Windows.
 *
 * Steps:
 * 1. Clear read-only attributes (attrib -R /S /D) - a no-op off Windows. Git
 *    object files are read-only and fs.rm cannot always unlink those.
 * 2. Remove recursively with `fs.rmSync`, retrying brief Windows handle locks.
 *
 * An earlier version ran `git gc --prune=now` first, "to allow Git to release
 * handles". That backfired: `git gc` runs synchronously (seconds per repo) and
 * auto-detaches, so it could itself hold the directory open and make the delete
 * fail with EPERM. Run once per leftover directory after every test, it was
 * also slow enough to blow the suite's 20s hook timeout. It has been removed.
 */
export function cleanTempDir(tmpDir: string): void {
  if (process.platform === 'win32') {
    try {
      // Step 1 - clear read-only flag recursively.
      cp.execFileSync('attrib', ['-R', '/S', '/D', `${tmpDir}\\*`], { stdio: 'ignore' });
    } catch {
      // Best-effort; fs.rm below still handles the common case.
    }
  }

  try {
    // Step 2 - final removal, retrying transient Windows handle locks.
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (e) {
    console.warn('cleanTempDir warning:', (e as any).message);
  }
}
