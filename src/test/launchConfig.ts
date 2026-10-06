/**
 * Launch configuration for the VS Code Electron test harness (runTest.ts).
 *
 * These helpers carry no Electron / @vscode/test-electron runtime dependency on
 * purpose: the launch contract can then be unit-tested headlessly (see
 * suite/shared/launchConfig.test.ts) without downloading or starting VS Code.
 */

/**
 * Fixed args handed to the Extension Development Host.
 *
 * `--disable-extensions` keeps the host's own installed extensions from
 * perturbing test results. It is a core VS Code CLI flag (still registered in
 * 1.140) and must NOT be dropped to work around a launch failure: the same
 * failure also rejects the `--no-sandbox` / `--disable-gpu-sandbox` args that
 * @vscode/test-electron always adds. See sanitizeLaunchEnv below.
 */
export const BASE_LAUNCH_ARGS: readonly string[] = ['--disable-extensions'];

/**
 * Build the `launchArgs` for @vscode/test-electron: the fixed args, then the
 * scratch workspace folder, then any caller-supplied extras.
 */
export function buildLaunchArgs(
  workspacePath: string,
  extraArgs: readonly string[] = []
): string[] {
  return [...BASE_LAUNCH_ARGS, workspacePath, ...extraArgs];
}

/**
 * Remove `ELECTRON_RUN_AS_NODE` from `env` (in place) and return it.
 *
 * @vscode/test-electron spawns the downloaded VS Code by copying the parent
 * environment verbatim (`Object.assign({}, process.env, ...)`). When the harness
 * is started from an Electron-hosted shell — a VS Code integrated terminal, the
 * ADO Code extension host, an agent runner — `ELECTRON_RUN_AS_NODE=1` is set and
 * is inherited by that child. The child `Code.exe` then boots as a plain Node
 * process, which does not understand the Electron/VS Code CLI flags:
 *
 *     Code.exe: bad option: --disable-extensions     (exit code 9)
 *
 * Scrubbing the variable forces a real Electron launch, which is the point of
 * `npm test`.
 */
export function sanitizeLaunchEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}
