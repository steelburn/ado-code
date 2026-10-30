import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

import {
    MAX_REQUEST_ID_LENGTH,
    parseDownstream,
    parseUpstream,
    serializeEvent,
    type AgentRunLike,
} from '../../../shared/remoteProtocol';

const RUN: AgentRunLike = {
    id: 'run-1-42',
    workItemId: 42,
    agent: 'opencode',
    workdir: 'd:\\ws',
    status: 'running',
    startedAt: '2026-01-01T00:00:00.000Z',
};

// The remote console mirrors the chat's own message shapes, so the protocol
// module must stay vscode-free: it is imported by headless suites AND by the
// extension host bundle.
suite('shared/remoteProtocol', () => {
    test('downstream payloads round-trip losslessly', () => {
        const events = [
            { type: 'agentStatus' as const, run: RUN, delta: 'half a line' },
            { type: 'agentResult' as const, run: { ...RUN, status: 'succeeded' as const }, summary: 'done' },
            {
                type: 'consentRequest' as const,
                requestId: 'req-1',
                tool: 'run_terminal_command',
                args: { command: 'npm test' },
                autoApproveMs: 5000,
                expiresAt: 1790000000000,
            },
            {
                type: 'confirmationRequest' as const,
                requestId: 'req-2',
                title: 'Commit?',
                description: '3 files',
                options: [{ label: 'Yes', value: 'yes' }, { label: 'No', value: 'no', isDangerous: true }],
            },
            { type: 'viewerCount' as const, count: 2 },
            {
                type: 'turnStatus' as const,
                turn: { sessionId: 's-1', title: 'Wire the console', startedAt: 1790000000000, background: false },
            },
            { type: 'turnStatus' as const, turn: null },
        ];

        for (const event of events) {
            const wire = serializeEvent(event);
            const parsed = parseDownstream(wire);
            assert.strictEqual(parsed.ok, true, `round-trip failed for ${event.type}: ${JSON.stringify(parsed)}`);
            if (parsed.ok) {
                assert.deepStrictEqual(parsed.value, event);
            }
        }
    });

    test('malformed JSON is rejected without throwing', () => {
        for (const bad of ['', '{', 'not json', 'null', '[]', '"str"']) {
            const parsed = parseDownstream(bad);
            assert.strictEqual(parsed.ok, false, `expected rejection for ${JSON.stringify(bad)}`);
        }
    });

    test('unknown event types and missing fields are rejected', () => {
        assert.strictEqual(parseDownstream({ type: 'nope' }).ok, false);
        assert.strictEqual(parseDownstream({ type: 'agentStatus', delta: 'x' }).ok, false);
        assert.strictEqual(parseDownstream({ type: 'viewerCount', count: 'many' }).ok, false);
        assert.strictEqual(parseDownstream({ type: 'viewerCount', count: -1 }).ok, false);
        assert.strictEqual(
            parseDownstream({ type: 'consentRequest', requestId: 'r', tool: 'x' }).ok,
            false
        );
    });

    test('turnStatus requires a session, a title and a finite start time', () => {
        assert.strictEqual(parseDownstream({ type: 'turnStatus' }).ok, false);
        assert.strictEqual(parseDownstream({ type: 'turnStatus', turn: 'running' }).ok, false);
        assert.strictEqual(parseDownstream({ type: 'turnStatus', turn: { title: 't', startedAt: 1 } }).ok, false);
        assert.strictEqual(
            parseDownstream({ type: 'turnStatus', turn: { sessionId: 's', title: 't', startedAt: 'now' } }).ok,
            false
        );
        // A finished turn is `null`, and background is coerced to a boolean.
        const stopped = parseDownstream({ type: 'turnStatus', turn: null });
        assert.strictEqual(stopped.ok, true);
        const running = parseDownstream({
            type: 'turnStatus',
            turn: { sessionId: 's', title: 't', startedAt: 1, background: 'yes' },
        });
        assert.strictEqual(running.ok, true);
        if (running.ok && running.value.type === 'turnStatus') {
            assert.strictEqual(running.value.turn?.background, false);
        }
    });

    test('transcript frames validate and keep the choice block', () => {
        const snapshot = parseDownstream({
            type: 'transcript',
            sessionId: 's-1',
            messages: [
                { id: 'u1', role: 'user', content: 'go' },
                { id: 'a2', role: 'assistant', content: 'pick', choice: { question: 'q', options: ['a', 'b', 3] } },
            ],
        });
        assert.strictEqual(snapshot.ok, true);
        if (snapshot.ok && snapshot.value.type === 'transcript') {
            assert.strictEqual(snapshot.value.sessionId, 's-1');
            assert.strictEqual(snapshot.value.messages.length, 2);
            assert.deepStrictEqual(
                snapshot.value.messages[1].choice,
                { question: 'q', options: ['a', 'b'] },
                'non-string options are dropped rather than rendered',
            );
        }
        const noSession = parseDownstream({ type: 'transcript', messages: [] });
        assert.ok(noSession.ok, 'an idle transcript is legal — messages is the only required field');
    });

    test('a transcript message needs an id, a known role and text', () => {
        assert.strictEqual(parseDownstream({ type: 'transcriptMessage', message: { role: 'user', content: 'x' } }).ok, false);
        assert.strictEqual(parseDownstream({ type: 'transcriptMessage', message: { id: 'm', role: 'system', content: 'x' } }).ok, false);
        assert.strictEqual(parseDownstream({ type: 'transcriptMessage', message: { id: 'm', role: 'user', content: 7 } }).ok, false);
        assert.strictEqual(parseDownstream({ type: 'transcript', messages: 'nope' }).ok, false);
        assert.strictEqual(parseDownstream({ type: 'transcriptDelta', id: 'm' }).ok, false);
        assert.strictEqual(parseDownstream({ type: 'transcriptDelta', id: 'm', delta: 'more' }).ok, true);
    });

    test('upstream session payload requires the fragment token', () => {
        assert.strictEqual(parseUpstream('session', { t: 'abc' }).ok, true);
        assert.strictEqual(parseUpstream('session', { t: '' }).ok, false);
        assert.strictEqual(parseUpstream('session', {}).ok, false);
        assert.strictEqual(parseUpstream('session', '{"t":123}').ok, false);
    });

    test('upstream consent payload validates the scope enum', () => {
        assert.strictEqual(parseUpstream('consent', { requestId: 'r1', approved: true }).ok, true);
        for (const scope of ['once', 'session', 'permanent']) {
            assert.strictEqual(
                parseUpstream('consent', { requestId: 'r1', approved: false, scope }).ok,
                true,
                `scope ${scope} should parse`
            );
        }
        assert.strictEqual(parseUpstream('consent', { requestId: 'r1', approved: true, scope: 'forever' }).ok, false);
        assert.strictEqual(parseUpstream('consent', { requestId: 'r1' }).ok, false);
    });

    test('upstream confirm payload accepts a value or an approval flag', () => {
        assert.strictEqual(parseUpstream('confirm', { requestId: 'r1', value: 'yes' }).ok, true);
        assert.strictEqual(parseUpstream('confirm', { requestId: 'r1', approved: false }).ok, true);
        assert.strictEqual(parseUpstream('confirm', { requestId: 'r1' }).ok, false);
    });

    test('oversized requestId is rejected', () => {
        const longId = 'x'.repeat(MAX_REQUEST_ID_LENGTH + 1);
        assert.strictEqual(parseUpstream('consent', { requestId: longId, approved: true }).ok, false);
        assert.strictEqual(parseUpstream('confirm', { requestId: longId, approved: true }).ok, false);
    });

    test('parseUpstream rejects unknown kinds and malformed bodies without throwing', () => {
        const viaKind = parseUpstream('nope' as never, { requestId: 'r', approved: true });
        assert.strictEqual(viaKind.ok, false);
        for (const bad of ['', '{', 'undefined', '[]']) {
            const parsed = parseUpstream('consent', bad);
            assert.strictEqual(parsed.ok, false, `expected rejection for ${JSON.stringify(bad)}`);
        }
    });

    test('protocol module never imports vscode', () => {
        const source = fs.readFileSync(
            path.resolve(__dirname, '../../../../src/shared/remoteProtocol.ts'),
            'utf8'
        );
        assert.ok(!/from\s+'vscode'/.test(source), 'remoteProtocol.ts must not import vscode');
        assert.ok(!/require\('vscode'\)/.test(source), 'remoteProtocol.ts must not require vscode');
        // The AgentRun type is imported type-only so the bundle keeps zero vscode edge.
        assert.ok(/import type/.test(source), 'AgentRun must be imported with import type');
    });
});
