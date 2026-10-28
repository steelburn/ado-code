import * as assert from 'assert';

import { CONSOLE_HTML } from '../../../remote/consolePage';

/**
 * The console page is shipped as an inline string, so these are static
 * assertions over the exact bytes the server will hand to a phone. They are
 * cheap and they catch the failure modes that only show up on a device: an
 * external asset behind a tunnel interstitial, or the token leaking into a URL.
 */
suite('remote/consolePage', () => {
    test('page is self-contained — no external asset of any kind', () => {
        assert.ok(!/<script[^>]+src=/i.test(CONSOLE_HTML), 'no external <script src>');
        assert.ok(!/<link\b/i.test(CONSOLE_HTML), 'no <link> (no external stylesheet, no icon)');
        assert.ok(!/@import/i.test(CONSOLE_HTML), 'no CSS @import');
        assert.ok(!/https?:\/\//i.test(CONSOLE_HTML), 'no absolute http(s) URL anywhere in the page');
        assert.ok(!/\/\/cdn/i.test(CONSOLE_HTML), 'no protocol-relative CDN reference');
        assert.ok(!/\bfetch\(\s*['"]https?:/i.test(CONSOLE_HTML), 'no cross-origin fetch');
    });

    test('the token is sent only to /session, never in a request URL', () => {
        // The fragment is read from location.hash and posted in a body.
        assert.match(CONSOLE_HTML, /location\.hash/);
        assert.match(CONSOLE_HTML, /method:\s*'POST'/);
        assert.match(CONSOLE_HTML, /JSON\.stringify\(\{\s*t:\s*token\s*\}\)/);

        // /events is opened with no query string and no token.
        const eventSourceCalls = [...CONSOLE_HTML.matchAll(/new EventSource\(([^)]*)\)/g)].map((m) => m[1]!.trim());
        assert.deepStrictEqual(eventSourceCalls, ["'/events'"]);

        // No URL built from the token: no `?t=` / `#t=` concatenation in requests.
        assert.ok(!/\/events\?/.test(CONSOLE_HTML), 'events URL must not carry a query string');
        assert.ok(!/['"]\s*\+\s*token/.test(CONSOLE_HTML), 'no request URL may concatenate the token');
        // The only place the token appears in a URL-ish string is the fragment read.
        const fragmentUses = [...CONSOLE_HTML.matchAll(/#t=/g)];
        assert.strictEqual(fragmentUses.length, 1, 'the fragment marker must appear exactly once');
    });

    test('the token is dropped from the address bar after sign-in', () => {
        assert.match(CONSOLE_HTML, /history\.replaceState/);
        const startAt = CONSOLE_HTML.indexOf('function start()');
        const endAt = CONSOLE_HTML.indexOf('start();', startAt);
        const startBody = CONSOLE_HTML.slice(startAt, endAt);
        assert.ok(
            startBody.indexOf('clearTokenFromAddressBar') < startBody.indexOf("fetch('/session'"),
            'the fragment must be cleared before the sign-in request leaves'
        );
    });

    test('phase 1 is view-only: no buttons, no click handlers, no mutation calls', () => {
        assert.ok(!/<button\b/i.test(CONSOLE_HTML), 'no buttons in P1');
        assert.ok(!/\bonclick=/i.test(CONSOLE_HTML), 'no inline click handlers');
        assert.ok(!/addEventListener\(\s*'click'/i.test(CONSOLE_HTML), 'no click listeners');
        for (const route of ['/consent', '/confirm', '/cancel']) {
            assert.ok(!CONSOLE_HTML.includes(`'${route}'`), `${route} must not be called in P1`);
        }
    });

    test('renders run status, deltas and prompts from the protocol events', () => {
        for (const type of ['agentStatus', 'agentResult', 'consentRequest', 'confirmationRequest', 'viewerCount']) {
            assert.ok(CONSOLE_HTML.includes(`case '${type}'`), `missing handler for ${type}`);
        }
    });

    test('output is escaped before it reaches innerHTML', () => {
        assert.match(CONSOLE_HTML, /function esc\(/);
        assert.match(CONSOLE_HTML, /&amp;/);
        assert.match(CONSOLE_HTML, /&lt;/);
        // Every interpolation into markup goes through esc().
        const interpolations = [...CONSOLE_HTML.matchAll(/\+\s*([A-Za-z0-9_.]+(?:\([^)]*\))?)\s*\+/g)]
            .map((m) => m[1]!)
            .filter((expression) => !/^(esc|'|")/.test(expression));
        assert.deepStrictEqual(interpolations, [], `unescaped interpolation(s): ${interpolations.join(', ')}`);
    });

    test('never uses eval, document.write or raw innerHTML sinks', () => {
        assert.ok(!/\beval\(/.test(CONSOLE_HTML));
        assert.ok(!/document\.write/.test(CONSOLE_HTML));
        // innerHTML may only receive the pre-escaped `html` string built above (and
        // literal placeholders) — never a protocol payload directly.
        for (const [, rhs] of CONSOLE_HTML.matchAll(/innerHTML\s*=\s*([^;]+)/g)) {
            assert.ok(
                !/\b(event|message|payload|run|state\.runs)\b/.test(rhs!),
                `innerHTML assigned from a raw payload: ${rhs!.trim().slice(0, 80)}`
            );
        }
    });

    test('is mobile-first and usable on a phone', () => {
        assert.match(CONSOLE_HTML, /<meta name="viewport" content="width=device-width/);
        assert.match(CONSOLE_HTML, /env\(safe-area-inset-top\)/);
        assert.match(CONSOLE_HTML, /prefers-color-scheme/);
        assert.match(CONSOLE_HTML, /prefers-color-scheme: light/);
        assert.strictEqual((CONSOLE_HTML.match(/<html/g) ?? []).length, 1);
        assert.strictEqual((CONSOLE_HTML.match(/<\/html>/g) ?? []).length, 1);
        assert.strictEqual((CONSOLE_HTML.match(/<script/g) ?? []).length, 1);
        assert.strictEqual((CONSOLE_HTML.match(/<\/script>/g) ?? []).length, 1);
        assert.ok(CONSOLE_HTML.startsWith('<!DOCTYPE html>'));
        assert.match(CONSOLE_HTML, /<meta name="referrer" content="no-referrer">/);
    });
});
