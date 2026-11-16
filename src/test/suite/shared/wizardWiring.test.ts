import * as assert from 'assert';
import {
  ARCHITECTURE_CAPABILITIES,
  ARCHITECTURE_OPTION_ID,
  ARCHITECTURE_STYLES,
} from '../../../shared/architectureStyles';
import { TEST_AUTOMATION_OPTIONS, isSuiteEnabled } from '../../../shared/testAutomationSuite';
import { PROJECT_TEMPLATES, TemplateOption } from '../../../webview-ui/src/components/ProjectCreationWizard/types';

/**
 * The wizard catalogue is the single place where an option becomes visible, so
 * these tests are the guard against the defect this wiring fixes: a shared
 * module with a generator behind it, but no control in the wizard that ever
 * sets its value.
 */
suite('Wizard wiring — architecture styles and test automation', () => {
  const option = (templateId: string, optionId: string): TemplateOption => {
    const template = PROJECT_TEMPLATES.find((t) => t.id === templateId);
    assert.ok(template, `template "${templateId}" must exist`);
    const found = template.options.find((o) => o.id === optionId);
    assert.ok(found, `template "${templateId}" must offer an option "${optionId}"`);
    return found;
  };

  const optionIds = (templateId: string): string[] =>
    PROJECT_TEMPLATES.find((t) => t.id === templateId)!.options.map((o) => o.id);

  test('every architecture-capable template offers the select, in style order', () => {
    const styleIds = ARCHITECTURE_STYLES.map((s) => s.id);
    for (const capability of ARCHITECTURE_CAPABILITIES) {
      const arch = option(capability.templateId, ARCHITECTURE_OPTION_ID);
      assert.strictEqual(arch.type, 'select', `${capability.templateId}: must be a select`);
      assert.deepStrictEqual(arch.options, styleIds, `${capability.templateId}: id list must match the shared module`);
      assert.deepStrictEqual(
        arch.options,
        [...capability.architectures],
        `${capability.templateId}: the wizard must offer exactly the styles the capability advertises`
      );
      assert.strictEqual(arch.default, styleIds[0], `${capability.templateId}: must default to the first style`);
    }
  });

  test('a template outside the capability list offers no architecture select', () => {
    const capable = new Set(ARCHITECTURE_CAPABILITIES.map((c) => c.templateId));
    const others = PROJECT_TEMPLATES.filter((t) => !capable.has(t.id));
    assert.ok(others.length > 0, 'sanity: some templates must not be architecture-capable');
    for (const template of others) {
      assert.ok(
        !template.options.some((o) => o.id === ARCHITECTURE_OPTION_ID),
        `${template.id}: must not offer an architecture select`
      );
    }
  });

  test('the five stack templates carry the testAutomation option group', () => {
    const groupIds = TEST_AUTOMATION_OPTIONS.map((o) => o.id);
    for (const capability of ARCHITECTURE_CAPABILITIES) {
      const ids = optionIds(capability.templateId);
      for (const id of groupIds) {
        assert.ok(ids.includes(id), `${capability.templateId}: must offer "${id}" from the shared group`);
      }
    }
  });

  test('the standalone test-automation template exists under its own category', () => {
    const template = PROJECT_TEMPLATES.find((t) => t.id === 'test-automation');
    assert.ok(template, 'the test-automation template must be scaffoldable');
    assert.strictEqual(template.category, 'testing');
    assert.deepStrictEqual(
      template.options.map((o) => o.id),
      TEST_AUTOMATION_OPTIONS.map((o) => o.id),
      'the template must offer exactly the shared option group'
    );
    assert.ok(
      !template.options.some((o) => o.id === ARCHITECTURE_OPTION_ID),
      'a suite repo has no architecture'
    );
  });

  test('reporting stays hidden until at least one suite is enabled', () => {
    const reporting = option('node-ts', 'reporting');
    assert.ok(reporting.showWhen, 'reporting must declare conditional visibility');
    const allOff = { e2e: false, api: false, perf: false };
    assert.strictEqual(reporting.showWhen!(allOff), false, 'hidden while every suite is off');
    assert.strictEqual(isSuiteEnabled(allOff), false, 'sanity: the shared predicate agrees');
    assert.strictEqual(reporting.showWhen!({ ...allOff, api: true }), true, 'visible once a suite is on');
  });

  test('every select labels its ids, so no raw id reaches the UI', () => {
    for (const template of PROJECT_TEMPLATES) {
      for (const opt of template.options) {
        if (opt.type !== 'select' || !opt.optionLabels) continue;
        for (const id of opt.options ?? []) {
          assert.ok(
            opt.optionLabels[id],
            `${template.id}.${opt.id}: select id "${id}" has no label`
          );
        }
      }
    }
    const arch = option('node-ts', ARCHITECTURE_OPTION_ID);
    assert.deepStrictEqual(
      arch.optionLabels, { 'layered': 'Layered (single deployable)', 'modular-monolith': 'Modular monolith', 'microservices': 'Microservices' },
      'the architecture ids must render with the shared labels'
    );
  });
  suite('Wizard template icons', () => {
    test('every template uses a glyph the webview can render, never codicon syntax', () => {
      for (const template of PROJECT_TEMPLATES) {
        assert.ok(template.icon && template.icon.trim().length > 0, `${template.id} needs an icon`);
        assert.ok(
          !template.icon.startsWith('$('),
          `${template.id} uses codicon syntax "${template.icon}" — the wizard is a webview and prints the string literally, so use an emoji`
        );
      }
    });
  });
});
