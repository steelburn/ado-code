import * as assert from 'assert';
import { markdownToHtml } from '../../../ado/markdownToHtml';

suite('markdownToHtml', () => {
  test('converts bold text', () => {
    const result = markdownToHtml('This is **bold** text');
    assert.strictEqual(result.includes('<strong>bold</strong>'), true, `Got: ${result}`);
  });

  test('converts italic text', () => {
    const result = markdownToHtml('This is *italic* text');
    assert.strictEqual(result.includes('<em>italic</em>'), true, `Got: ${result}`);
  });

  test('converts bold and italic', () => {
    const result = markdownToHtml('This is ***bold italic*** text');
    assert.strictEqual(result.includes('<strong><em>bold italic</em></strong>'), true, `Got: ${result}`);
  });

  test('converts headings', () => {
    const result = markdownToHtml('# Heading 1\n## Heading 2\n### Heading 3');
    assert.strictEqual(result.includes('<h1>Heading 1</h1>'), true, `Got: ${result}`);
    assert.strictEqual(result.includes('<h2>Heading 2</h2>'), true, `Got: ${result}`);
    assert.strictEqual(result.includes('<h3>Heading 3</h3>'), true, `Got: ${result}`);
  });

  test('converts unordered lists', () => {
    const result = markdownToHtml('- Item 1\n- Item 2\n- Item 3');
    assert.strictEqual(result.includes('<ul>'), true, `Got: ${result}`);
    assert.strictEqual(result.includes('<li>Item 1</li>'), true, `Got: ${result}`);
    assert.strictEqual(result.includes('<li>Item 2</li>'), true, `Got: ${result}`);
  });

  test('converts ordered lists', () => {
    const result = markdownToHtml('1. First\n2. Second\n3. Third');
    assert.strictEqual(result.includes('<ol>'), true, `Got: ${result}`);
    assert.strictEqual(result.includes('<li>First</li>'), true, `Got: ${result}`);
  });

  test('converts inline code', () => {
    const result = markdownToHtml('Use `npm install` to install');
    assert.strictEqual(result.includes('<code>npm install</code>'), true, `Got: ${result}`);
  });

  test('converts code blocks', () => {
    const result = markdownToHtml('```javascript\nconst x = 1;\n```');
    assert.strictEqual(result.includes('<pre><code'), true, `Got: ${result}`);
    assert.strictEqual(result.includes('const x = 1;'), true, `Got: ${result}`);
  });

  test('converts links', () => {
    const result = markdownToHtml('[Click here](https://example.com)');
    assert.strictEqual(result.includes('<a href="https://example.com">Click here</a>'), true, `Got: ${result}`);
  });

  test('converts checkboxes', () => {
    const result = markdownToHtml('- [x] Done item\n- [ ] Todo item');
    assert.strictEqual(result.includes('☑ Done item'), true, `Got: ${result}`);
    assert.strictEqual(result.includes('☐ Todo item'), true, `Got: ${result}`);
  });

  test('escapes HTML entities', () => {
    const result = markdownToHtml('Use <div> and & characters');
    assert.strictEqual(result.includes('&lt;div&gt;'), true, `Got: ${result}`);
    assert.strictEqual(result.includes('&amp;'), true, `Got: ${result}`);
  });

  test('handles empty input', () => {
    const result = markdownToHtml('');
    assert.strictEqual(result, '');
  });

  test('handles null/undefined input', () => {
    const result = markdownToHtml(null as any);
    assert.strictEqual(result, '');
  });

  test('converts horizontal rule', () => {
    const result = markdownToHtml('Before\n---\nAfter');
    assert.strictEqual(result.includes('<hr>'), true, `Got: ${result}`);
  });

  test('handles line breaks', () => {
    const result = markdownToHtml('Line 1\nLine 2');
    assert.strictEqual(result.includes('<br>'), true, `Got: ${result}`);
  });

  test('handles paragraphs', () => {
    const result = markdownToHtml('Paragraph 1\n\nParagraph 2');
    assert.strictEqual(result.includes('</p><p>'), true, `Got: ${result}`);
  });

  test('separates a numbered list that follows a bullet list', () => {
    const result = markdownToHtml('- Setup\n- Configure\n\n1. Run install\n2. Verify');
    assert.ok(result.includes('<ul><li>Setup</li><li>Configure</li></ul>'), `Got: ${result}`);
    assert.ok(result.includes('<ol><li>Run install</li><li>Verify</li></ol>'), `Got: ${result}`);
    // Every <li> must sit inside a list wrapper — a legal predecessor is
    // only <ul>/<ol> (list start) or </li> (continuation).
    const bare = [...result.matchAll(/<li>/g)].filter(m => {
      const before = result.slice(0, m.index);
      return !/<[ou]l>$/.test(before) && !/<\/li>$/.test(before);
    });
    assert.strictEqual(bare.length, 0, `no bare <li> outside a list wrapper: ${result}`);
  });

  test('separates a bullet list that follows a numbered list', () => {
    const result = markdownToHtml('1. First\n2. Second\n- Extra\n- More');
    assert.ok(result.includes('<ol><li>First</li><li>Second</li></ol>'), `Got: ${result}`);
    assert.ok(result.includes('<ul><li>Extra</li><li>More</li></ul>'), `Got: ${result}`);
  });

  test('does not emit <br> after headings or inside code blocks', () => {
    const result = markdownToHtml('# Title\n- item\n```js\nconst a = 1;\nconst b = 2;\n```');
    assert.ok(!result.includes('<h1>Title</h1><br>'), `Got: ${result}`);
    assert.ok(!result.includes('const a = 1;<br>'), `Got: ${result}`);
    assert.ok(result.includes('<pre><code class="language-js">const a = 1;\nconst b = 2;</code></pre>'), `Got: ${result}`);
  });

  test('converts indented numbered continuation lines into an ordered list', () => {
    // The proposed-tasks round-trip indents continuation lines; they must
    // render as a real <ol> instead of bare text.
    const result = markdownToHtml('Implement the form.\n  1. Add fields\n  2. Add validation');
    assert.ok(result.includes('<ol><li>Add fields</li><li>Add validation</li></ol>'), `Got: ${result}`);
    assert.ok(result.includes('<p>Implement the form.</p>'), `Got: ${result}`);
  });
});
