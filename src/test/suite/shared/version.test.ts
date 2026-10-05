import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

import {
    EXTENSION_VERSION,
    ADO_CODE_USER_AGENT,
} from '../../../shared/version';

// Guardrail for the extension version identity.
//
// The version lives in TWO hand-maintained places:
//   1. package.json "version"  (source of truth — the marketplace manifest)
//   2. src/shared/version.ts   EXTENSION_VERSION — folded into the User-Agent
//      that every LLM request announces to providers/gateways
// Nothing enforced agreement between them, so the constant silently lagged a
// release: the manifest moved ahead while every LLM request still announced the
// previous release's version, making version-tagged provider logs wrong. These
// tests fail the moment the two drift apart (or the User-Agent stops deriving
// from the constant, e.g. gets re-hardcoded in a provider).
//
// The same agreement is enforced at packaging time by scripts/check-version.js,
// so a drift can neither merge (pre-commit runs this suite) nor ship.

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const PACKAGE_JSON = path.join(REPO_ROOT, 'package.json');
const SRC_DIR = path.join(REPO_ROOT, 'src');
const VERSION_FILE = 'shared/version.ts';

/** Read package.json "version" — the released manifest version. */
function packageVersion(): string {
    return JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8')).version;
}

/** Every .ts file under src/ (excluding the webview-ui sub-project). */
function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        // Test sources legitimately contain version fixtures/regexes and are
        // never shipped, so the hardcode scan skips them.
        if (entry.name === 'webview-ui' || entry.name === 'node_modules' || entry.name === 'test') {
            continue;
        }
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            out.push(...sourceFiles(full));
        } else if (entry.isFile() && entry.name.endsWith('.ts')) {
            out.push(full);
        }
    }
    return out;
}

suite('shared/version', () => {
    test('EXTENSION_VERSION mirrors package.json "version"', () => {
        assert.strictEqual(
            EXTENSION_VERSION,
            packageVersion(),
            'src/shared/version.ts EXTENSION_VERSION has drifted from ' +
                'package.json — set the constant to the manifest version',
        );
    });

    test('EXTENSION_VERSION is a plain semver release', () => {
        assert.match(
            EXTENSION_VERSION,
            /^\d+\.\d+\.\d+$/,
            'EXTENSION_VERSION must be a bare semver release (e.g. 0.7.0)',
        );
    });

    test('User-Agent identifies ADO Code at the current version', () => {
        assert.strictEqual(
            ADO_CODE_USER_AGENT,
            `ADO-Code/${EXTENSION_VERSION} (+https://github.com/steelburn/ado-code)`,
            'the User-Agent must be derived from EXTENSION_VERSION, not hardcoded',
        );
    });

    test('no source file hardcodes an ADO-Code/<version> User-Agent', () => {
        const rel = (base: string, f: string): string =>
            path.relative(base, f).split(path.sep).join('/');

        const offenders = sourceFiles(SRC_DIR)
            .filter((f) => rel(SRC_DIR, f) !== VERSION_FILE)
            .filter((f) => /ADO-Code\/\d+\.\d+\.\d+/.test(fs.readFileSync(f, 'utf8')))
            .map((f) => rel(REPO_ROOT, f));

        assert.deepStrictEqual(
            offenders,
            [],
            'these files hardcode a version in the User-Agent instead of ' +
                'importing ADO_CODE_USER_AGENT from src/shared/version.ts',
        );
    });
});
