import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { runTests } from '@vscode/test-electron';
import { buildLaunchArgs, sanitizeLaunchEnv } from './launchConfig';

async function main() {
  try {
    const extensionDevelopmentPath = path.resolve(__dirname, '../../');
    const extensionTestsPath = path.resolve(__dirname, './suite/index');
    const vscodeExecutablePath = process.env.VSCODE_EXECUTABLE_PATH;
    // Extra VS Code launch args (space-separated) for sandboxed/container
    // environments, e.g. ADO_CODE_TEST_EXTRA_ARGS="--no-sandbox --disable-dev-shm-usage".
    const extraArgs = (process.env.ADO_CODE_TEST_EXTRA_ARGS ?? '').split(' ').filter(Boolean);
    // The downloaded VS Code must start as Electron, not as Node: an inherited
    // ELECTRON_RUN_AS_NODE makes Code.exe reject our CLI flags ("bad option").
    sanitizeLaunchEnv(process.env);
    await runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: buildLaunchArgs(path.join(os.tmpdir(), 'ado-code-test-workspace'), extraArgs),
    });
  } catch (err) {
    console.error('Failed to run tests:', err);
    process.exitCode = 1;
  }
}

// The suites create their throwaway dirs under <checkout>/.ado-code/test-scratch
// (the only writable place under the extension-host write sandbox). One dir per
// mkdtemp means a run leaves hundreds behind, so wipe the slate on both ends;
// `.ado-code/` is gitignored, so nothing here can reach the repo.
const SCRATCH_ROOT = path.join(path.resolve(__dirname, '../../'), '.ado-code', 'test-scratch');
function resetScratch(): void {
  fs.rmSync(SCRATCH_ROOT, { recursive: true, force: true });
}

resetScratch();
main()
  .catch((err) => {
    console.error('Failed to run tests:', err);
    process.exitCode = 1;
  })
  .finally(resetScratch);
