import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

// Guards the part of the Dependencies step a host smoke test cannot see.
//
// The host test proves the *probe* works; it cannot paint React. A manual visual
// check in a real VS Code window looked for three things, and each one has a
// cheap source-level invariant that fails loudly if the step regresses:
//
//   1. every class the step renders has a rule in the wizard stylesheet — a
//      missing rule shows up as an unstyled list of dependency cards;
//   2. the *Next* gate and the step's own hint read the same shared decision
//      (`dependencyGate`), so the button can never disagree with the hint;
//   3. the per-OS install command is copyable, because the whole point of the
//      step is that the user can act on it outside the wizard.

const webviewSrc = path.resolve(__dirname, '../../../../src/webview-ui/src');
const wizardDir = path.join(webviewSrc, 'components', 'ProjectCreationWizard');
const stepFile = path.join(wizardDir, 'StepDependencies.tsx');
const wizardIndexFile = path.join(wizardDir, 'index.tsx');
const wizardStyles = path.join(wizardDir, 'styles.css');
const appStyles = path.join(webviewSrc, 'styles', 'app.css');

function read(file: string): string {
    assert.ok(fs.existsSync(file), `expected ${path.relative(webviewSrc, file)} to exist`);
    return fs.readFileSync(file, 'utf8');
}

/** Class tokens the step actually renders, from className strings and templates. */
function renderedClasses(source: string): string[] {
    const found = new Set<string>();
    const patterns = [/className="([^"]*)"/g, /className=\{`([^`]*)`\}/g, /className=\{[^}]*'([^']*)'[^}]*\}/g];
    for (const pattern of patterns) {
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(source)) !== null) {
            for (const token of match[1].split(/[^A-Za-z0-9_-]+/)) {
                if (token) found.add(token);
            }
        }
    }
    return [...found].sort();
}

/** Only the step's own namespace; shared chrome classes live in the global sheet. */
function renderedDependencyClasses(source: string): string[] {
    return renderedClasses(source).filter(c => c.startsWith('wizard-dep'));
}

/** Selectors the stylesheet defines. */
function styledClasses(css: string): string[] {
    const found = new Set<string>();
    const pattern = /\.(wizard-dep[A-Za-z0-9_-]*)/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(css)) !== null) found.add(match[1]);
    return [...found].sort();
}

suite('Dependencies step — static invariants', () => {
    test('yields the state classes the stylesheet styles', () => {
        const rendered = renderedClasses(read(stepFile));
        // The card states are the only conditional classes; without them the
        // found/missing/optional distinction disappears visually.
        for (const state of ['is-ok', 'is-missing', 'is-optional']) {
            assert.ok(rendered.includes(state), `the step no longer renders the "${state}" card state`);
        }
        assert.ok(rendered.length >= 8, `expected the step to render its full set of classes, got ${rendered.length}`);
    });

    test('every rendered class has a rule in the wizard stylesheet', () => {
        const rendered = renderedDependencyClasses(read(stepFile));
        const styled = styledClasses(read(wizardStyles));
        const unstyled = rendered.filter(c => !styled.includes(c));
        assert.deepStrictEqual(unstyled, [], `classes rendered without a CSS rule: ${unstyled.join(', ')}`);
    });

    test('keeps its rules in the wizard stylesheet instead of the global one', () => {
        const leaked = styledClasses(read(appStyles));
        assert.deepStrictEqual(leaked, [], `wizard dependency rules leaked into styles/app.css: ${leaked.join(', ')}`);
    });

    test('the step and the *Next* gate read the same shared decision', () => {
        const step = read(stepFile);
        const wizard = read(wizardIndexFile);
        assert.ok(
            /dependencyGate\(report, acknowledged\)/.test(step),
            'StepDependencies should derive blocking/canAutoInstall from dependencyGate(report, acknowledged)',
        );
        // The step 3 branch of canProceed must not re-derive the rule by hand.
        const gateBranch = /case 3:[\s\S]*?return ([^;]+);/.exec(wizard);
        assert.ok(gateBranch, 'wizard canProceed should still have a case 3 branch for the Dependencies step');
        assert.ok(
            /dependencyGate\(dependencyReport, dependenciesAcknowledged\)\.blocked/.test(gateBranch[1]),
            `the Dependencies step gate must hang on dependencyGate(...).blocked, found: ${gateBranch[1].trim()}`,
        );
        assert.ok(
            !/missingRequired/.test(gateBranch[1]),
            'the gate must not read the host summary directly — that is the drift this test exists to stop',
        );
    });

    test('offers the install command as copyable text', () => {
        const step = read(stepFile);
        assert.ok(/navigator\.clipboard/.test(step), 'the per-OS install command should be copyable');
        assert.ok(
            /className="[^"]*wizard-copy-btn[^"]*"/.test(step),
            'the copy affordance should render its own control (wizard-copy-btn)',
        );
    });
});
