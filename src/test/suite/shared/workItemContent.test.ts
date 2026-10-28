import * as assert from 'assert';
import {
    normalizeRichText,
    isWorkItemBodyEcho,
    isWorkItemEchoComment,
    splitAcceptanceCriteria,
    normalizeWorkItemContent,
} from '../../../shared/workItemContent';

suite('shared/workItemContent', () => {
    const body = [
        '<h2>Remote console</h2>',
        '<p>Expose the chat over SSE so a phone can drive the extension. The host',
        'guards every request with a token, exchanges the session once, and keeps',
        'the approval prompts local-only.</p>',
    ].join('\n');

    suite('normalizeRichText', () => {
        test('strips html tags and entities and folds whitespace', () => {
            assert.strictEqual(
                normalizeRichText('<div>Hello&nbsp;<b>World</b></div>'),
                'hello world',
            );
        });

        test('drops markdown punctuation so bullets compare equal to plain text', () => {
            assert.strictEqual(normalizeRichText('- **A** item\n- B item'), 'a item b item');
        });
    });

    suite('isWorkItemBodyEcho', () => {
        test('the same text as markdown vs html is an echo', () => {
            const markdown = '## Remote console\n\nExpose the chat over SSE so a phone can drive the extension.\nThe host guards every request with a token, exchanges the session once, and keeps the approval prompts local-only.';
            assert.ok(isWorkItemBodyEcho(markdown, body));
        });

        test('an echo wrapped in a preamble still counts', () => {
            const comment = `Created the item:\n\n${body}`;
            assert.ok(isWorkItemBodyEcho(comment, body));
        });

        test('new information is not an echo', () => {
            const comment = 'Implementation note: the SSE endpoint lives in RemoteServer and the token is regenerated on every start, so the QR code needs a refresh.';
            assert.strictEqual(isWorkItemBodyEcho(comment, body), false);
        });

        test('a short comment is never an echo', () => {
            assert.strictEqual(isWorkItemBodyEcho('Remote console', 'Remote console'), false);
        });

        test('an unrelated long comment is not an echo', () => {
            const other = 'Reviewed the delivery report and everything listed as done is really merged on the branch; the remaining child item still needs the docs page.';
            assert.strictEqual(isWorkItemBodyEcho(other, body), false);
        });
    });

    suite('isWorkItemEchoComment', () => {
        test('matches against either field', () => {
            const ac = '- The QR code renders on the status bar panel and survives a reload of the window';
            assert.ok(isWorkItemEchoComment(ac, { description: body, acceptanceCriteria: ac }));
            assert.strictEqual(isWorkItemEchoComment(ac, { description: body }), false);
            assert.strictEqual(isWorkItemEchoComment(ac, undefined), false);
        });
    });

    suite('splitAcceptanceCriteria', () => {
        test('moves an ## Acceptance Criteria section into the field', () => {
            const description = [
                'Implement the mobile console page.',
                '',
                '## Acceptance Criteria',
                '',
                '- Page renders on a 390px viewport',
                '- Approvals stay on the desktop',
                '',
                '## Notes',
                'Keep it dependency-free.',
            ].join('\n');
            const out = splitAcceptanceCriteria(description);
            assert.strictEqual(
                out.acceptanceCriteria,
                '- Page renders on a 390px viewport\n- Approvals stay on the desktop',
            );
            assert.ok(out.description.includes('Implement the mobile console page.'));
            assert.ok(out.description.includes('## Notes'));
            assert.ok(out.description.includes('Keep it dependency-free.'));
            assert.ok(!/Acceptance Criteria/i.test(out.description));
        });

        test('handles a bold label and a trailing section', () => {
            const out = splitAcceptanceCriteria('Do the thing.\n\n**Acceptance Criteria**\n- It works');
            assert.strictEqual(out.description, 'Do the thing.');
            assert.strictEqual(out.acceptanceCriteria, '- It works');
        });

        test('a description without an AC section is unchanged', () => {
            const out = splitAcceptanceCriteria('Just a description.\n\n## Context\nMore text.');
            assert.strictEqual(out.description, 'Just a description.\n\n## Context\nMore text.');
            assert.strictEqual(out.acceptanceCriteria, '');
        });

        test('a provided value wins and the section body is appended when different', () => {
            const out = splitAcceptanceCriteria('Body\n\n## Acceptance Criteria\n- Section bullet', '- Field bullet');
            assert.strictEqual(out.acceptanceCriteria, '- Field bullet\n\n- Section bullet');
        });

        test('an identical section is not duplicated', () => {
            const out = splitAcceptanceCriteria('Body\n\n## Acceptance Criteria\n- Same bullet', '- Same bullet');
            assert.strictEqual(out.acceptanceCriteria, '- Same bullet');
        });

        test('an empty AC heading is removed from the description', () => {
            const out = splitAcceptanceCriteria('Body\n\n## Acceptance Criteria\n');
            assert.strictEqual(out.description, 'Body');
            assert.strictEqual(out.acceptanceCriteria, '');
        });
    });

    suite('normalizeWorkItemContent', () => {
        test('leaves an item without a description untouched', () => {
            const fields = { title: 'T' } as { title: string; description?: string; acceptanceCriteria?: string };
            assert.strictEqual(normalizeWorkItemContent(fields), fields);
        });

        test('returns the description without the AC section plus the AC field', () => {
            const out = normalizeWorkItemContent({
                title: 'T',
                description: 'Body\n\n## Acceptance Criteria\n- bullet',
                acceptanceCriteria: undefined as string | undefined,
            });
            assert.strictEqual(out.description, 'Body');
            assert.strictEqual(out.acceptanceCriteria, '- bullet');
        });
    });
});
