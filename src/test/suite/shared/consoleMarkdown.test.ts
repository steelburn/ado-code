import * as assert from 'assert';

import { CONSOLE_HTML } from '../../../remote/consolePage';

/**
 * The phone has no markdown component — the console page ships no dependencies —
 * so an answer is rendered by md-lite, a block of plain browser JS living inside
 * the page. Asserting over its source would only prove the code was pasted in,
 * so the delimited block is extracted verbatim and evaluated here instead.
 */
function loadMarkdownRenderer(): (text: string) => string {
    const markStart = CONSOLE_HTML.indexOf('md-lite:start');
    const markEnd = CONSOLE_HTML.indexOf('md-lite:end');
    assert.ok(markStart !== -1 && markEnd > markStart, 'the page delimits its markdown block');
    // esc() sits immediately before the start marker and is part of the block.
    const escStart = CONSOLE_HTML.lastIndexOf('function esc(', markStart);
    assert.ok(escStart !== -1, 'esc() is inside the extracted range');
    // The end marker is a comment tail, so stop after its closing `*/`: a bare
    // slice would leave the comment unterminated and the block unparsable.
    const closeComment = CONSOLE_HTML.indexOf('*/', markEnd);
    const source = CONSOLE_HTML.slice(escStart, closeComment === -1 ? markEnd : closeComment + 2);
    const factory = new Function(source + '\nreturn renderMarkdown;') as () => (text: string) => string;
    return factory();
}

suite('remote/consolePage markdown', () => {
    const render = loadMarkdownRenderer();
    // Built from char codes so this file needs no literal fences.
    const fence = String.fromCharCode(96, 96, 96);

    test('a single line break stays a break, a blank line starts a paragraph', () => {
        assert.match(render('first line\nsecond line'), /<p class="md-p">first line<br>second line<\/p>/);
        assert.match(render('first\n\nsecond'), /<p class="md-p">first<\/p>[\s\S]*<p class="md-p">second<\/p>/);
        // Answers arrive with CRLF more often than not, so the carriage return
        // has to be consumed rather than shown as a stray break.
        assert.match(render('a\r\nb'), /a<br>b/);
        assert.ok(!render('a\r\nb').includes('\r'), 'no carriage return survives');
    });

    test('a pipe table becomes a real table, with alignment', () => {
        const html = render(['| Suite | Result |', '| :--- | ---: |', '| sha | pass |', '| remote | pass |'].join('\n'));
        assert.match(html, /<div class="md-scroll"><table class="md-table">/, 'a wide row scrolls, it does not stretch the page');
        assert.match(html, /<th>Suite<\/th>/, 'left alignment is the default');
        assert.match(html, /<th class="md-end">Result<\/th>/);
        assert.match(html, /<td>sha<\/td>/);
        assert.match(html, /<td class="md-end">pass<\/td>/);
        assert.strictEqual((html.match(/<tr>/g) || []).length, 3, 'one header row and two body rows');
    });

    test('raw html and dangerous links never become live markup', () => {
        const tag = render('<img src=x onerror=alert(1)>');
        assert.ok(!tag.includes('<img'), 'the tag is escaped, not emitted');
        assert.ok(tag.includes('&lt;img'), 'the text itself survives');

        const link = render('[click](javascript:alert(1))');
        assert.ok(!/href=/.test(link), 'a javascript: url is never linkified');
        assert.ok(link.includes('click'), 'the label is still shown');

        const cell = render(['| a |', '| --- |', '| <b>x</b> |'].join('\n'));
        assert.ok(!cell.includes('<b>'), 'table cells are escaped too');
    });

    test('a fenced block keeps its language and its line breaks, escaped', () => {
        const html = render([fence + 'ts', 'const a = 1;', 'const b = 2;', fence].join('\n'));
        assert.match(html, /<pre class="md-code" data-lang="ts"><code>const a = 1;\nconst b = 2;<\/code><\/pre>/);

        const script = render([fence, '<script>x</script>', fence].join('\n'));
        assert.ok(!script.includes('<script>'), 'code is escaped');
        assert.ok(script.includes('&lt;script&gt;'), 'and still readable');
    });

    test('headings, lists and quotes keep their structure', () => {
        assert.match(render('## Result'), /<div class="md-h[^"]*">Result<\/div>/);
        assert.match(render('- one\n- two'), /<ul class="md-list"><li[^>]*>one<\/li>/);
        assert.match(render('1. one\n2. two'), /<ol class="md-list">/);
        assert.match(render('> quoted'), /<div class="md-quote">[^<]*quoted/);
    });

    test('the transcript renders bodies through it', () => {
        assert.match(
            CONSOLE_HTML,
            /class="msg-body md">' \+ renderMarkdown\(message\.content\) \+ '<\/div>/,
            'the answer body goes through the renderer',
        );
        // <br> only survives if the body is not laid out with pre-wrap.
        assert.match(CONSOLE_HTML, /\.msg-body\.md\s*\{[^}]*white-space:\s*normal/);
    });
});
