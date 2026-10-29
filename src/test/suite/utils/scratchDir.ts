import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Scratch directories for the test suites.
 *
 * `os.tmpdir()` is the natural home for throwaway dirs, but it is not writable
 * in every host. The VS Code extension host used by the Electron harness runs the
 * suite under a write sandbox: %TEMP%, %USERPROFILE%, %APPDATA%, C:\ProgramData
 * and even D:\ all answer EPERM for `mkdtempSync`, while the checkout itself is
 * itself is writable. Two consequences this module fixes:
 *
 *  1. Temp-dependent tests fail with EPERM instead of doing their job;
 *  2. when the call sits at suite-registration scope it throws while Mocha is
 *     still loading files, which aborts the whole run *before* a single test is
 *     reported - the harness just exits 1 with no test output at all.
 *
 * The root is resolved once, by probing candidates in order:
 *   ADO_CODE_TEST_SCRATCH (explicit override, for CI)
 *   -> .ado-code/test-scratch inside the checkout
 *   -> os.tmpdir()
 * and then fails with an actionable message. The checkout-local root is the
 * default because the sandbox leaves the checkout writable while the temp
 * directory is not, and it keeps the scratch dirs next to the workspace data
 * they relate to. `.ado-code/` is gitignored, so they never enter the repo.
 *
 * Because that root sits below the worktree root, git treats every scratch dir as
 * part of the developer's repo unless the suite gives it its own boundary. A
 * suite that executes `git` must therefore `git init` inside its scratch dir
 * first: an unguarded `git commit` there would commit to the developer's repo and
 * re-enter its husky pre-commit hook, which runs this very suite. `isInsideCheckout`
 * exists to make that guard explicit (and to keep it honest when someone points
 * ADO_CODE_TEST_SCRATCH at the checkout).
 *
 * Suites asserting the *opposite* - that a directory is NOT a git repository -
 * cannot use this root at all and must call `makeDirOutsideRepo`.
 *
 * Always call these from a `suiteSetup` / test body, never at suite-registration
 * scope: a throw during `Mocha.loadFiles` hides every test in the run.
 */

/** Repo root — `src/test/suite/utils` and `out/test/suite/utils` both sit 4 deep. */
const CHECKOUT = path.resolve(__dirname, '../../../..');

const CHECKOUT_SCRATCH = path.join(CHECKOUT, '.ado-code', 'test-scratch');

let cachedRoot: string | undefined;

/** True when `dir` is the checkout or lives below it. */
export function isInsideCheckout(dir: string): boolean {
  const rel = path.relative(CHECKOUT, path.resolve(dir));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function isWritableRoot(root: string): boolean {
  try {
    fs.mkdirSync(root, { recursive: true });
    const probe = fs.mkdtempSync(path.join(root, 'probe-'));
    fs.rmSync(probe, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/** First writable scratch root, resolved once per process. */
export function scratchRoot(): string {
  if (cachedRoot) {
    return cachedRoot;
  }
  const candidates = [process.env.ADO_CODE_TEST_SCRATCH, CHECKOUT_SCRATCH, os.tmpdir()];
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    const root = path.resolve(candidate);
    if (isWritableRoot(root)) {
      cachedRoot = root;
      return root;
    }
  }
  throw new Error(
    `no writable scratch root (tried ${candidates.filter(Boolean).join(', ')}). ` +
      'This host allows the test suites to write nowhere - the VS Code extension host ' +
      'runs under a write sandbox that answers EPERM even for the checkout. ' +
      'Set ADO_CODE_TEST_SCRATCH to a writable directory to run the suites here.'
  );
}

/** Absolute path of the repository checkout the suites run from. */
export function checkoutRoot(): string {
  return CHECKOUT;
}

/** Create a fresh throwaway directory under `scratchRoot()`. */
export function makeScratchDir(prefix: string): string {
  return fs.mkdtempSync(path.join(scratchRoot(), prefix));
}

/** True when git does not consider `dir` part of any work tree. */
function isOutsideWorkTree(dir: string): boolean {
  try {
    const out = cp.execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return String(out).trim() !== 'true';
  } catch {
    // git missing or unhappy - either way it reports no work tree here.
    return true;
  }
}

/**
 * A throwaway directory that is NOT part of any git work tree, for suites that
 * assert the "not a repository" contract. The shared scratch root is unusable
 * for those: it lives inside the checkout, so `git rev-parse
 * --is-inside-work-tree` answers true for every directory below it.
 *
 * Probes roots outside the checkout, verifying with git itself that the result is
 * outside a work tree. Returns undefined when this host forbids writing anywhere
 * else, so the caller can skip with a visible reason instead of asserting on a
 * premise it cannot create.
 */
export function makeDirOutsideRepo(prefix: string): string | undefined {
  const candidates = [process.env.ADO_CODE_TEST_SCRATCH_OUTSIDE_REPO, os.tmpdir(), path.dirname(CHECKOUT)];
  for (const candidate of candidates) {
    if (!candidate || isInsideCheckout(candidate)) {
      continue;
    }
    const root = path.resolve(candidate);
    let dir: string;
    try {
      fs.mkdirSync(root, { recursive: true });
      dir = fs.mkdtempSync(path.join(root, prefix));
    } catch {
      continue;
    }
    if (isOutsideWorkTree(dir)) {
      return dir;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return undefined;
}
