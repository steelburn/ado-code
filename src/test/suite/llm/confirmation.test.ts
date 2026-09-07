import * as assert from 'assert';
import { createConfirmationBroker } from '../../../llm/confirmation';

suite('ConfirmationBroker', () => {
  test('choosing an option resolves the decision with its value', async () => {
    const broker = createConfirmationBroker();
    const options = [
      { label: 'Yes', value: 'yes' },
      { label: 'No', value: 'no' },
    ];
    const { requestId, decision } = broker.request({ title: 't', description: 'd', options });
    broker.resolve(requestId, 'yes');
    assert.strictEqual(await decision, 'yes');
    assert.strictEqual(broker.pending, null);
  });

  test('a stale requestId is ignored (timeout still cancels)', async () => {
    const broker = createConfirmationBroker(30);
    const { requestId, decision } = broker.request({ title: 't', description: 'd', options: [] });
    broker.resolve('bogus-id', 'yes');
    assert.strictEqual(await decision, null, 'unanswered request auto-cancels');
    assert.ok(requestId.length > 0);
  });

  test('timeout auto-cancels without an answer and reports the expiry', async () => {
    const events: Array<{ id: string }> = [];
    const broker = createConfirmationBroker(20, (req) => events.push({ id: req.requestId }));
    const { requestId, decision } = broker.request({ title: 't', description: 'd', options: [{ label: 'A', value: 'a' }] });
    assert.strictEqual(await decision, null, 'no answer → null (same as cancel)');
    assert.strictEqual(broker.pending, null);
    assert.deepStrictEqual(events, [{ id: requestId }], 'expiry reported to the host (card clear)');
  });

  test('an explicit answer suppresses the timeout callback', async () => {
    const events: Array<{ id: string }> = [];
    const broker = createConfirmationBroker(20, (req) => events.push({ id: req.requestId }));
    const { requestId, decision } = broker.request({ title: 't', description: 'd', options: [] });
    broker.resolve(requestId, 'keep');
    assert.strictEqual(await decision, 'keep');
    await new Promise(r => setTimeout(r, 40));
    assert.deepStrictEqual(events, [], 'no expiry callback once the user answered');
  });

  test('request returns an expiresAt deadline the card can count down to', () => {
    const before = Date.now();
    const broker = createConfirmationBroker();
    const { requestId, expiresAt } = broker.request({ title: 't', description: 'd', options: [] });
    assert.ok(expiresAt >= before + 119000 && expiresAt <= before + 121000,
      `auto-cancel deadline ~now+120s (got ${expiresAt - before})`);
    broker.resolve(requestId, ''); // clean up the pending timer
  });

  test('rejectAll cancels the pending request (webview disposed / chat cleared)', async () => {
    const broker = createConfirmationBroker();
    const { decision } = broker.request({ title: 't', description: 'd', options: [] });
    broker.rejectAll();
    assert.strictEqual(await decision, null);
    assert.strictEqual(broker.pending, null);
  });

  test('a new request supersedes an unanswered one', async () => {
    const broker = createConfirmationBroker();
    const first = broker.request({ title: 'one', description: 'd', options: [] });
    const second = broker.request({ title: 'two', description: 'd', options: [] });
    assert.strictEqual(await first.decision, null, 'superseded request cancels');
    broker.resolve(second.requestId, 'chosen');
    assert.strictEqual(await second.decision, 'chosen');
    assert.strictEqual(broker.pending, null);
  });

  test('pause freezes the auto-cancel; resume keeps the remaining time', async () => {
    const events: Array<{ id: string }> = [];
    const broker = createConfirmationBroker(50, (req) => events.push({ id: req.requestId }));
    const { requestId, decision } = broker.request({ title: 't', description: 'd', options: [{ label: 'A', value: 'a' }] });
    await new Promise(r => setTimeout(r, 15)); // burn part of the window
    broker.pause();
    assert.ok(broker.paused, 'paused reports true');
    await new Promise(r => setTimeout(r, 70)); // would have cancelled at 50ms
    assert.deepStrictEqual(events, [], 'no auto-cancel while paused');
    broker.resume();
    assert.strictEqual(broker.paused, false, 'paused reports false after resume');
    assert.strictEqual(await decision, null, 'still auto-cancels after resume');
    assert.deepStrictEqual(events, [{ id: requestId }], 'expiry fires once, after resume');
  });

  test('resume re-bases expiresAt onto the frozen remaining time', async () => {
    const broker = createConfirmationBroker();
    broker.request({ title: 't', description: 'd', options: [] });
    broker.pause();
    await new Promise(r => setTimeout(r, 20));
    broker.resume();
    const remaining = broker.pending!.expiresAt - Date.now();
    assert.ok(remaining > 110000, `~full window survives a pause (got ${remaining}ms remaining)`);
    broker.resolve(broker.pending!.requestId, '');
  });

  test('the user can still answer while paused', async () => {
    const broker = createConfirmationBroker(20);
    const { requestId, decision } = broker.request({ title: 't', description: 'd', options: [] });
    broker.pause();
    broker.resolve(requestId, 'yes');
    assert.strictEqual(await decision, 'yes');
    assert.strictEqual(broker.paused, false, 'answering clears the paused state');
  });
});
