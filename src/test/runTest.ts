import * as path from 'path';
import * as os from 'os';
import { runTests } from '@vscode/test-electron';

async function main() {
  try {
    const extensionDevelopmentPath = path.resolve(__dirname, '../../');
    const extensionTestsPath = path.resolve(__dirname, './suite/index');
    const vscodeExecutablePath = process.env.VSCODE_EXECUTABLE_PATH;
    // Extra VS Code launch args (space-separated) for sandboxed/container
    // environments, e.g. ADO_CODE_TEST_EXTRA_ARGS="--no-sandbox --disable-dev-shm-usage".
    const extraArgs = (process.env.ADO_CODE_TEST_EXTRA_ARGS ?? '').split(' ').filter(Boolean);
    await runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: ['--disable-extensions', path.join(os.tmpdir(), 'ado-code-test-workspace'), ...extraArgs],
    });
  } catch (err) {
    console.error('Failed to run tests:', err);
    process.exit(1);
  }
}

main();
