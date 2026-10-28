import * as assert from 'assert';

import { isUnregisteredSettingError } from '../../../config/settings';

// Regression for:
//   Failed to save "artifacts.enabled": Unable to write to User Settings
//   because adoCode.artifacts.enabled is not a registered configuration.
//
// VS Code rejects a settings write when the *running window* has not registered
// the key — the classic case is an extension update installed while the window
// stayed open, so the new bundle's Configuration page offers settings the
// window's registry does not know yet. Nothing in the extension can fix that
// write, but it can recognise the failure and ask for the reload that does.
suite('Settings write failures (stale contributed manifest)', () => {
  test('recognises VS Code\u2019s "not a registered configuration" rejection', () => {
    const err = new Error(
      'Unable to write to User Settings because adoCode.artifacts.enabled is not a registered configuration.'
    );
    assert.strictEqual(isUnregisteredSettingError(err), true);
  });

  test('recognises it when the rejection arrives as a plain string', () => {
    assert.strictEqual(
      isUnregisteredSettingError(
        'Unable to write to Workspace Settings because adoCode.artifacts.enabled is not a registered configuration.'
      ),
      true
    );
  });

  test('recognises it case-insensitively', () => {
    assert.strictEqual(
      isUnregisteredSettingError(new Error('… BECAUSE ADOCODE.ARTIFACTS.ENABLED IS NOT A REGISTERED CONFIGURATION.')),
      true
    );
  });

  test('does not mistake other write failures for a stale manifest', () => {
    assert.strictEqual(
      isUnregisteredSettingError(
        new Error('Unable to write to User Settings because adoCode.artifacts.retentionDays value must be of type number.')
      ),
      false
    );
    assert.strictEqual(isUnregisteredSettingError(new Error('EPERM: operation not permitted, open settings.json')), false);
    assert.strictEqual(isUnregisteredSettingError(undefined), false);
    assert.strictEqual(isUnregisteredSettingError(''), false);
  });
});
