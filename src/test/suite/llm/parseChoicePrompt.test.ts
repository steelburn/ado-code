import * as assert from 'assert';
import { LlmClient } from '../../../llm/client';
import {
  parseChoicePrompt,
  looksLikeChoiceQuestion,
  parseChoiceDetectorJson,
  detectChoicePrompt,
} from '../../../llm/parseChoicePrompt';

// The exact shape that motivated the LLM fallback: ends with a question
// ("Want me to ... and/or ...?") but has NO numbered/bulleted options.
const NATURAL_OFFER = [
  'My recommendation',
  'Finish #21234 first — it\'s already done. An external agent completed the implementation and it\'s sitting uncommitted on a feature branch.',
  'Want me to run the post-agent impact check on the #21234 changes now (per your instruction), and/or update the work item states (e.g., #21234 → Resolved once you confirm)?',
].join('\n');

function sseResponse(jsonContent: string): any {
  const encoder = new TextEncoder();
  return {
    ok: true,
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: jsonContent } }] })}\n\n`));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    }),
  };
}

function makeClient(model = 'detect-model') {
  return new LlmClient({
    provider: 'openai',
    apiUrl: 'https://api.example.com/v1',
    apiKey: 'test-key',
    model,
  });
}

suite('parseChoicePrompt (regex fast path)', () => {
  test('extracts numbered options from a classic choice response', () => {
    const text = 'Which do you prefer?\n1. Commit the changes\n2. Update the states';
    const p = parseChoicePrompt(text);
    assert.ok(p);
    assert.strictEqual(p.options.length, 2);
  });

  test('misses a natural-language offer without numbered options (the gap)', () => {
    assert.strictEqual(parseChoicePrompt(NATURAL_OFFER), null);
  });
});

suite('looksLikeChoiceQuestion (LLM-call gate)', () => {
  test('true for a trailing offer question', () => {
    assert.strictEqual(looksLikeChoiceQuestion(NATURAL_OFFER), true);
  });

  test('false for a plain statement', () => {
    assert.strictEqual(looksLikeChoiceQuestion('Here is the summary of the work items and their statuses.'), false);
  });

  test('false for empty / oversized / too-short text', () => {
    assert.strictEqual(looksLikeChoiceQuestion(''), false);
    assert.strictEqual(looksLikeChoiceQuestion('x'.repeat(5000)), false);
    assert.strictEqual(looksLikeChoiceQuestion('Want me to go?'), false); // < 40 chars
  });
});

suite('parseChoiceDetectorJson', () => {
  test('parses fenced JSON', () => {
    const p = parseChoiceDetectorJson('```json\n{"question": "Q?", "options": ["A", "B"]}\n```');
    assert.deepStrictEqual(p, {
      question: 'Q?',
      options: [{ label: 'A', value: 'A' }, { label: 'B', value: 'B' }],
    });
  });

  test('parses bare JSON with prose prefix', () => {
    const p = parseChoiceDetectorJson('Sure! Here you go: {"question": "Q?", "options": ["A", "B"]}');
    assert.ok(p);
    assert.strictEqual(p.question, 'Q?');
  });

  test('returns null for {"none": true}', () => {
    assert.strictEqual(parseChoiceDetectorJson('{"none": true}'), null);
  });

  test('returns null for garbage / wrong shapes', () => {
    assert.strictEqual(parseChoiceDetectorJson('not json at all'), null);
    assert.strictEqual(parseChoiceDetectorJson('{"question": "only"}'), null);
    assert.strictEqual(parseChoiceDetectorJson('{"question": "Q?", "options": ["single"]}'), null);
    assert.strictEqual(parseChoiceDetectorJson('{"question": "Q?", "options": []}'), null);
  });
});

suite('detectChoicePrompt (LLM fallback)', () => {
  test('extracts a structured prompt for a natural-language offer', async () => {
    const json = '{"question": "Run the post-agent impact check now?", "options": ["Run the impact check", "Update work item states", "Do nothing"]}';
    let capturedBody: any;
    (globalThis as any).fetch = async (_url: any, init: any) => {
      capturedBody = JSON.parse(init.body);
      return sseResponse(json);
    };

    const p = await detectChoicePrompt(NATURAL_OFFER, makeClient('cheap-model'));
    assert.ok(p, 'fallback extracted a prompt');
    assert.strictEqual(p.question, 'Run the post-agent impact check now?');
    assert.strictEqual(p.options.length, 3);
    assert.strictEqual(capturedBody.model, 'cheap-model', 'model override reaches the request');
  });

  test('returns null when the model says none', async () => {
    (globalThis as any).fetch = async () => sseResponse('{"none": true}');
    const p = await detectChoicePrompt('Would you like me to summarize the changes now that everything is done?', makeClient());
    assert.strictEqual(p, null);
  });

  test('returns null WITHOUT calling the LLM for plain statements', async () => {
    let called = false;
    (globalThis as any).fetch = async () => { called = true; return sseResponse('{"none": true}'); };
    const p = await detectChoicePrompt('The build is green. No further action required.', makeClient());
    assert.strictEqual(p, null);
    assert.strictEqual(called, false, 'heuristic gate skipped the LLM call');
  });

  test('returns null when the LLM call fails (never breaks the chat)', async () => {
    (globalThis as any).fetch = async () => { throw new Error('network down'); };
    const p = await detectChoicePrompt('The changes are ready. Want me to commit the changes now?', makeClient());
    assert.strictEqual(p, null);
  });
});
