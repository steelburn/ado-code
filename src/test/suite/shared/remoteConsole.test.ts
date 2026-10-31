import * as assert from 'assert';

import { CONSOLE_HTML } from '../../../remote/consolePage';

/**
 * The console page is shipped as an inline string, so these are static
 * assertions over the exact bytes the server will hand to a phone. They are
 * cheap and they catch the failure modes that only show up on a device: an
 * external asset behind a tunnel interstitial, or the token leaking into a URL.
 */
suite('remote/consolePage', () => {
    test('replays the job that is still progressing on (re)connect', () => {
        assert.ok(CONSOLE_HTML.includes("fetch('/runs'"), 'the console asks for in-flight runs');
        // The replay has to sit in onopen, not in the initial load: the phone
        // sleeps, the EventSource reconnects, and the job that started during
        // that gap would otherwise never appear.
        const openAt = CONSOLE_HTML.indexOf('source.onopen = function ()');
        assert.ok(openAt > 0, 'onopen handler is present');
        const openBody = CONSOLE_HTML.slice(openAt, CONSOLE_HTML.indexOf('};', openAt));
        assert.ok(openBody.includes('loadRuns()'), 'in-flight runs are replayed on every reconnect');
    });

    test('replays the chat turn that is generating on (re)connect', () => {
        // A chat turn is not an agent run, so `agentStatus` never mentions it:
        // without this replay the page said "nothing running" while the loop
        // streamed and called tools.
        assert.ok(CONSOLE_HTML.includes("fetch('/turn'"), 'the console asks for the in-flight turn');
        const openAt = CONSOLE_HTML.indexOf('source.onopen = function ()');
        assert.ok(openAt > 0, 'onopen handler is present');
        const openBody = CONSOLE_HTML.slice(openAt, CONSOLE_HTML.indexOf('};', openAt));
        assert.ok(openBody.includes('loadTurn()'), 'the in-flight turn is replayed on every reconnect');
        // Live updates for the turn arrive on the stream, and the card has to be
        // re-rendered from them (otherwise only a reload would ever update it).
        assert.ok(CONSOLE_HTML.includes("case 'turnStatus'"), 'turnStatus frames update the card');
    });

    test('mirrors the conversation, choices included, on (re)connect', () => {
        assert.match(CONSOLE_HTML, /fetch\('\/transcript'/);
        const openAt = CONSOLE_HTML.search(/source\.onopen\s*=/);
        assert.ok(openAt > 0, 'the page opens an EventSource');
        const openBody = CONSOLE_HTML.slice(openAt, CONSOLE_HTML.indexOf('};', openAt));
        assert.ok(
            openBody.includes('loadTranscript()'),
            'the thread is replayed on every (re)connect, not only on first load',
        );
        for (const type of ['transcript', 'transcriptMessage', 'transcriptDelta']) {
            assert.ok(CONSOLE_HTML.includes(`case '${type}'`), `missing handler for ${type}`);
        }
    });

    test('a choice block renders as buttons that answer through /chat', () => {
        assert.match(CONSOLE_HTML, /data-choice="/);
        assert.match(CONSOLE_HTML, /fetch\('\/chat'/);
        // The request id rides along with the answer: without it the host
        // cannot tell which card on screen was answered, and two open cards
        // with a shared option label would both close.
        assert.match(
            CONSOLE_HTML,
            /JSON\.stringify\(\{ text: text, choiceRequestId: choiceRequestId \}\)/
        );
        assert.match(CONSOLE_HTML, /markChoiceAnswered\(/);
    });

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

    test('approvals are answerable, but only through the guarded decision routes', () => {
        assert.ok(!/\bonclick=/i.test(CONSOLE_HTML), 'no inline click handlers');
        assert.strictEqual(
            [...CONSOLE_HTML.matchAll(/addEventListener\(\s*'click'/g)].length,
            2,
            'two delegated click listeners — the approval cards and the mirrored thread — never inline handlers'
        );
        assert.ok(CONSOLE_HTML.includes("'/consent'"), 'consent decisions post to /consent');
        assert.ok(CONSOLE_HTML.includes("'/confirm'"), 'confirmations post to /confirm');
        // Abort stays host-side: the phone never invents a cancel.
        assert.ok(!CONSOLE_HTML.includes("'/cancel'"), 'no /cancel from the console');
    });

    test('a card cannot be answered twice', () => {
        const clickAt = CONSOLE_HTML.indexOf("addEventListener('click'");
        assert.ok(clickAt > 0, 'click handler present');
        const handler = CONSOLE_HTML.slice(clickAt, CONSOLE_HTML.indexOf('function loadPending'));
        // Optimistic lock before the request leaves…
        assert.match(handler, /if \(!card \|\| card\.sent\) \{ return; \}/);
        assert.match(handler, /card\.sent = true;/);
        // …and every button of that card renders disabled while in flight.
        assert.match(CONSOLE_HTML, /card\.sent \? ' disabled' : ''/);
        // 409 = the other surface already decided. Gone is gone.
        assert.match(handler, /response\.status === 409/);
        // And a resolution broadcast from VS Code removes the card.
        assert.match(CONSOLE_HTML, /case 'approvalResolved'/);
    });

    test('a page that loads mid-prompt picks up the open card', () => {
        assert.match(CONSOLE_HTML, /fetch\('\/pending'/);
        assert.match(CONSOLE_HTML, /credentials:\s*'same-origin'/);
        // Re-sync on every SSE (re)connect: SSE has no replay of its own.
        const openAt = CONSOLE_HTML.indexOf('source.onopen');
        const openBody = CONSOLE_HTML.slice(openAt, CONSOLE_HTML.indexOf('source.onmessage'));
        assert.ok(openBody.includes('loadPending()'), 'onopen must re-sync pending approvals');
    });

    test('the plan card shows the goal and the to-do list, and re-syncs on (re)connect', () => {
        assert.match(CONSOLE_HTML, /id="plan"/);
        assert.ok(CONSOLE_HTML.includes("case 'plan'"), 'plan events are handled');
        assert.match(CONSOLE_HTML, /fetch\('\/plan'/);
        // SSE carries no replay, so a page that joins or reloads mid-run re-reads
        // the plan exactly the way it re-reads /runs, /transcript and /pending.
        const openAt = CONSOLE_HTML.indexOf('source.onopen');
        assert.ok(openAt > 0, 'the SSE source has an onopen handler');
        const openBody = CONSOLE_HTML.slice(openAt, CONSOLE_HTML.indexOf('source.onmessage', openAt));
        assert.ok(openBody.includes('loadPlan()'), 'onopen must re-sync the plan');
        // One glyph per state: done, in progress, pending.
        assert.ok(CONSOLE_HTML.includes('✔'), 'done glyph');
        assert.ok(CONSOLE_HTML.includes('▸'), 'in-progress glyph');
        assert.ok(CONSOLE_HTML.includes('○'), 'pending glyph');
        assert.ok(CONSOLE_HTML.includes('steps done'), 'the card summarises progress');
    });

    test('the inline page script parses', () => {
        const script = CONSOLE_HTML.slice(CONSOLE_HTML.indexOf('<script>') + 8, CONSOLE_HTML.indexOf('</script>'));
        assert.ok(script.length > 1000, 'script body present');
        assert.doesNotThrow(() => new Function(script));
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

    test('a single-page app: views are routed in place, never fetched', () => {
        // One document and one stream, so a tab switch cannot drop a live
        // approval or force the phone to re-establish the connection.
        assert.strictEqual([...CONSOLE_HTML.matchAll(/<nav\b/g)].length, 1, 'one tab bar');
        assert.strictEqual([...CONSOLE_HTML.matchAll(/data-view=/g)].length, 5, 'five routed views');
        for (const view of ['thread', 'goal', 'changes', 'approvals', 'runs']) {
            assert.ok(CONSOLE_HTML.includes('data-view="' + view + '"'), view + ' is reachable from the tab bar');
        }
        assert.strictEqual((CONSOLE_HTML.match(/new EventSource\(/g) ?? []).length, 1, 'one event stream');
        assert.ok(!/location\.(assign|replace)\(/.test(CONSOLE_HTML), 'no navigation away from the app');
        assert.ok(!/location\.href\s*=/.test(CONSOLE_HTML), 'no full page load');
        assert.ok(!/fetch\('\/(console|app|runs\?view)/.test(CONSOLE_HTML), 'views are not fetched as markup');
        assert.match(CONSOLE_HTML, /window\.addEventListener\('hashchange'/, 'the router follows the back gesture');
        assert.match(CONSOLE_HTML, /#view=/, 'the route lives in the fragment');
    });

    test('a QR fragment may carry a route without keeping the token', () => {
        assert.ok(
            CONSOLE_HTML.includes("hash.slice(3).split('&')[0]"),
            'the token ends at the first parameter separator'
        );
        const startAt = CONSOLE_HTML.indexOf('function start()');
        const startBody = CONSOLE_HTML.slice(startAt, CONSOLE_HTML.indexOf('start();', startAt));
        assert.ok(startBody.indexOf('parseView()') > 0, 'the route is read at boot');
        assert.ok(
            startBody.indexOf('parseView()') < startBody.indexOf('clearTokenFromAddressBar'),
            'the route is captured before the token fragment is scrubbed'
        );
    });

    test('pending work still advertises itself from another view', () => {
        // Both markers are part of the shell: they exist before any event arrives.
        assert.match(CONSOLE_HTML, /id="approvals-count"/);
        assert.match(CONSOLE_HTML, /id="runs-count"/);
        assert.match(CONSOLE_HTML, /id="thread-dot"/);
        assert.ok(CONSOLE_HTML.includes('function syncBadges()'), 'badges follow state, not the view');
    });

    test('tool calls are drawn under the message that made them', () => {
        // The host pairs a call with its assistant message; the console renders
        // what arrives on the message and never guesses the pairing itself.
        assert.ok(CONSOLE_HTML.includes('function inlineTools(message)'), 'an inline renderer exists');
        assert.match(CONSOLE_HTML, /html \+= inlineTools\(message\);/, 'the thread calls it per message');
        assert.match(CONSOLE_HTML, /if \(message\.tools\) \{ existing\.tools = message\.tools; \}/,
            'an updated message carries its new calls');
        assert.match(CONSOLE_HTML, /existing\.toolCount = message\.toolCount;/, 'the real total travels too');
        assert.match(CONSOLE_HTML, /\.msg\.tool-only \.msg-body \{ display: none; \}/,
            'a calls-only message is not an empty bubble');
        assert.match(CONSOLE_HTML, /\.msg-tool\.stalled \.msg-tool-dot/, 'a call that never settled reads as stalled');
        assert.ok(
            CONSOLE_HTML.includes("'<span class=\"msg-tool-detail\">' + esc(String(entry.detail))"),
            'the digest is escaped like every other interpolation'
        );
    });

    test('the thread opens on the newest message and keeps following it', () => {
        // A phone that joins an hour-long run must land on the last bubble, not
        // on the first frame of the replay.
        assert.match(CONSOLE_HTML, /var stickToLatest = true;/, 'the page opens pinned to the end');
        assert.match(CONSOLE_HTML, /function nearLatest\(\)/, 'there is a bottom test');
        assert.match(CONSOLE_HTML, /function followLatest\(\)/, 'there is a scroller');
        assert.match(CONSOLE_HTML, /if \(!stickToLatest\) \{ return; \}/, 'following is releasable');
        // Scrolling away releases the follow, scrolling back re-arms it: a
        // reader who is mid-conversation must not be yanked back to the bottom.
        assert.match(
            CONSOLE_HTML,
            /window\.addEventListener\('scroll', function \(\) \{ stickToLatest = nearLatest\(\); \}, \{ passive: true \}\)/,
            'the follow is re-armed by arriving at the bottom'
        );
        // Every render and every switch to Thread re-applies it.
        assert.ok(
            (CONSOLE_HTML.match(/followLatest\(\);/g) ?? []).length >= 2,
            'both a render and the Thread route follow the end'
        );
        assert.match(
            CONSOLE_HTML,
            /if \(changed\) \{ stickToLatest = true; followLatest\(\); \}/,
            'opening Thread lands on the newest message'
        );
    });

    test('the Goal view states the objective and groups the milestones', () => {
        // The compact plan card in the thread answers "how far along"; the tab
        // answers "what is this agent even doing", so it must not be the same
        // flat list again.
        assert.ok(CONSOLE_HTML.includes('data-view="goal"'), 'Goal is a tab');
        assert.match(CONSOLE_HTML, /function renderGoal\(\)/, 'it has its own renderer');
        assert.match(CONSOLE_HTML, /function loadPlan\(\)/, 'a phone joining mid-run replays it from /plan');
        assert.ok(CONSOLE_HTML.includes('esc(goal)'), 'the objective is escaped and shown in full');
        assert.match(CONSOLE_HTML, /class="goal-bar"/, 'progress is a bar, not a sentence');
        assert.match(CONSOLE_HTML, /class="goal-bar" role="img" aria-label=/, 'the bar is readable to a screen reader');
        for (const label of ['In progress', 'Next', 'Done']) {
            assert.ok(CONSOLE_HTML.includes("'" + label + "'"), label + ' is a milestone group');
        }
        // A session with no plan says so instead of rendering an empty page.
        assert.match(CONSOLE_HTML, /if \(!goal && !todos\.length\) \{/);
    });

    test('the Files view lists what the agent changed, newest first', () => {
        assert.ok(CONSOLE_HTML.includes('data-view="changes"'), 'Files is a tab');
        assert.match(CONSOLE_HTML, /function renderChanges\(\)/, 'it has its own renderer');
        assert.match(CONSOLE_HTML, /fetch\('\/files'/, 'the client pulls the snapshot on load');
        assert.match(CONSOLE_HTML, /case 'files': \{/, 'live files frames are applied too');
        assert.match(CONSOLE_HTML, /<div class="file-row /, 'one row per file');
        assert.match(CONSOLE_HTML, /esc\(String\(file\.status \|\| 'ok'\)\)/, 'the status drives the row class, escaped');
        assert.match(CONSOLE_HTML, /for \(var i = list\.length - 1; i >= 0; i--\)/, 'newest first');
        // The directory fades out so the file NAME survives a 390px row.
        assert.ok(CONSOLE_HTML.includes('class="file-dir"'), 'the directory is de-emphasised, not dropped');
        assert.ok(CONSOLE_HTML.includes('most recently touched files'), 'a capped list says it is capped');
        assert.match(CONSOLE_HTML, /function syncFilesBadge\(\)/, 'the tab counts what has arrived');
    });

    test('the reply box is pinned above the tab bar, not scrolled away', () => {
        assert.match(CONSOLE_HTML, /\.composer \{[^}]*position: fixed;/, 'the composer leaves the flow');
        assert.match(
            CONSOLE_HTML,
            /bottom: calc\(62px \+ env\(safe-area-inset-bottom\)\)/,
            'it sits on the tab bar and clears the phone home indicator'
        );
        // Content must not hide under it.
        assert.match(CONSOLE_HTML, /padding-bottom: 150px;/, 'main and footer reserve its height');
    });

    test('Send is the most prominent control and reports its own state', () => {
        // Filled with the accent colour rather than outlined like every other
        // control: it is the one action the page exists for.
        assert.match(
            CONSOLE_HTML,
            /\.send \{[^}]*linear-gradient\(135deg, #2f81f7, #1a5fd0\)/,
            'Send is accent-filled'
        );
        assert.match(CONSOLE_HTML, /\.send \{[^}]*min-height: 44px/, 'and a real tap target');
        for (const state of ['sending', 'sent', 'failed']) {
            assert.match(
                CONSOLE_HTML,
                new RegExp('\\.send\\[data-state="' + state + '"\\]'),
                state + ' has its own look'
            );
        }
        assert.match(CONSOLE_HTML, /@keyframes send-spin/, 'in flight is animated, not just greyed');
        assert.match(CONSOLE_HTML, /function setSendState\(next\)/, 'the state machine is one function');
        assert.match(
            CONSOLE_HTML,
            /sendBtn\.disabled = next === 'sending';/,
            'a double tap cannot post the reply twice'
        );
        assert.ok(CONSOLE_HTML.includes('Retry'), 'a failure invites a second attempt');
    });
});
