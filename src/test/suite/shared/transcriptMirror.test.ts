import * as assert from 'assert';

import type { RemoteDownstreamEvent } from '../../../shared/remoteProtocol';
import { TranscriptMirror } from '../../../webview/TranscriptMirror';

/**
 * The mirror is the only reason the phone sees the conversation at all: the
 * webview keeps its messages in React state, so what the host forwards here is
 * the whole transcript on the wire. These tests pin the two behaviours the
 * console depends on — one stable id per streamed answer, and a choice fence
 * that turns into structure instead of JSON in a bubble.
 */
suite('webview/TranscriptMirror', () => {
    function make(): { mirror: TranscriptMirror; events: RemoteDownstreamEvent[] } {
        const events: RemoteDownstreamEvent[] = [];
        const mirror = new TranscriptMirror(event => events.push(event), () => 's-1');
        return { mirror, events };
    }

    test('a streamed answer keeps one id across deltas and finalizes in place', () => {
        const { mirror, events } = make();
        mirror.noteAssistant(undefined, 'Hel', false);
        mirror.noteAssistant(undefined, 'lo there', false);
        mirror.noteAssistant(undefined, '', true);

        const deltas = events.filter(event => event.type === 'transcriptDelta');
        const finals = events.filter(event => event.type === 'transcriptMessage');
        assert.strictEqual(deltas.length, 2, 'each chunk is one delta');
        assert.strictEqual(finals.length, 1, 'the done chunk finalizes the message');
        const ids = new Set(deltas.map(event => (event.type === 'transcriptDelta' ? event.id : '')));
        assert.strictEqual(ids.size, 1, 'every delta of one answer shares one id');
        const final = finals[0];
        assert.ok(final && final.type === 'transcriptMessage');
        assert.strictEqual(final.message.id, [...ids][0], 'the final frame reuses that id');
        assert.strictEqual(final.message.content, 'Hello there');
        assert.deepStrictEqual(mirror.snapshot().messages.map(message => message.content), ['Hello there']);
    });

    test('the next answer gets its own bubble', () => {
        const { mirror } = make();
        mirror.noteAssistant(undefined, 'one', false);
        mirror.noteAssistant(undefined, '', true);
        mirror.noteAssistant(undefined, 'two', false);
        mirror.noteAssistant(undefined, '', true);
        const messages = mirror.snapshot().messages;
        assert.deepStrictEqual(messages.map(message => message.content), ['one', 'two']);
        assert.notStrictEqual(messages[0].id, messages[1].id);
    });

    test('a choice fence becomes structured options and leaves the text', () => {
        const { mirror } = make();
        const fence = '```choice\n' +
            '{"question":"Which layout?","options":["grid","list"]}\n' +
            '```';
        mirror.noteAssistant(undefined, `Two ways to go:\n\n${fence}`, true);

        const message = mirror.snapshot().messages[0];
        assert.deepStrictEqual(message.choice, { question: 'Which layout?', options: ['grid', 'list'] });
        assert.strictEqual(message.content, 'Two ways to go:', 'the raw fence never reaches a bubble');
    });

    test('an answer without a fence carries no choice', () => {
        const { mirror } = make();
        mirror.noteAssistant(undefined, 'Just prose.', true);
        assert.strictEqual(mirror.snapshot().messages[0].choice, undefined);
    });

    test('object options keep their labels instead of stringifying to [object Object]', () => {
        const { mirror, events } = make();
        mirror.noteAssistant(undefined, 'Pick one:', true);
        // The desktop renders its buttons from `{ label, value }` option objects.
        // Passing those straight through used to stringify every label, leaving
        // the phone an answer with no answerable options at all.
        mirror.noteChoice('Which?', [
            { label: 'Run the suite', value: 'run' },
            { value: 'skip' },
        ]);
        const last = events[events.length - 1];
        assert.strictEqual(last.type, 'transcriptMessage');
        const message = (last as Extract<RemoteDownstreamEvent, { type: 'transcriptMessage' }>).message;
        assert.deepStrictEqual(message.choice?.options, ['Run the suite', 'skip']);
        assert.ok(
            !message.choice?.options.some(option => option.includes('[object')),
            'no stringified options reach the console',
        );
        assert.strictEqual(message.choice?.question, 'Which?');
    });

    test('a user turn is mirrored as its own message', () => {
        const { mirror, events } = make();
        mirror.noteUser('  ship it  ');
        assert.deepStrictEqual(events, [
            { type: 'transcriptMessage', message: { id: 'u1', role: 'user', content: 'ship it' } },
        ]);
    });

    test('an empty user turn is not mirrored', () => {
        const { mirror, events } = make();
        mirror.noteUser('   ');
        assert.deepStrictEqual(events, []);
    });

    test('history restore replaces the thread and replays it as one snapshot', () => {
        const { mirror, events } = make();
        mirror.noteUser('old turn');
        mirror.reset([
            { role: 'user', content: 'first' },
            { role: 'assistant', content: 'answer', trace: { tools: [] } },
            { role: 'system', content: 'ignored' },
        ] as Array<{ role?: unknown; content?: unknown }>);
        const last = events[events.length - 1];
        assert.ok(last && last.type === 'transcript');
        assert.deepStrictEqual(last.messages.map(message => message.content), ['first', 'answer']);
        assert.strictEqual(last.sessionId, 's-1', 'the snapshot is stamped with the session it mirrors');
        assert.deepStrictEqual(mirror.snapshot().messages.length, 2);
    });

    test('a restored choice block is structured too', () => {
        const { mirror } = make();
        mirror.reset([
            { role: 'assistant', content: 'Pick:\n\n```choice\n{"question":"Which?","options":["a","b"]}\n```' },
        ]);
        const message = mirror.snapshot().messages[0];
        assert.deepStrictEqual(message.choice, { question: 'Which?', options: ['a', 'b'] });
        assert.strictEqual(message.content, 'Pick:');
    });

    test('the thread is bounded: the oldest messages fall off first', () => {
        const events: RemoteDownstreamEvent[] = [];
        const mirror = new TranscriptMirror(event => events.push(event), () => null, 3);
        for (let i = 0; i < 5; i += 1) {
            mirror.noteUser(`m${i}`);
        }
        assert.deepStrictEqual(
            mirror.snapshot().messages.map(message => message.content),
            ['m2', 'm3', 'm4'],
        );
    });

    test('a long message is capped so one answer cannot flood a tunnel', () => {
        const mirror = new TranscriptMirror(() => undefined, () => null, 10, 10);
        mirror.noteAssistant(undefined, 'x'.repeat(50), true);
        const content = mirror.snapshot().messages[0].content;
        assert.strictEqual(content.length, 11, 'capped text plus the ellipsis');
        assert.ok(content.endsWith('…'));
    });
});
