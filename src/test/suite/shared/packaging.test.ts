import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { CHAT_EDITOR_VIEW_TYPE } from '../../../webview/chatEditorSerializer';

function findRepoRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    if (
      fs.existsSync(path.join(dir, 'package.json')) &&
      fs.existsSync(path.join(dir, '.vscodeignore'))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  throw new Error('could not locate repository root from ' + __dirname);
}

/**
 * Guards the packaged artifact's file list: development-only metadata
 * (CI workflows, git hooks) must never ship inside the .vsix.
 */
suite('Packaging hygiene', () => {
  function ignorePatterns(): string[] {
    const raw = fs.readFileSync(path.join(findRepoRoot(), '.vscodeignore'), 'utf8');
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'));
  }

  const developmentOnlyDirs = ['.github', '.husky'];

  // Secrets (registry publish tokens) must never ship. `.env` is gitignored,
  // but vsce packages from .vscodeignore, so it needs its own exclusion here.
  const secretFiles = ['.env'];

  for (const file of secretFiles) {
    test(`.vscodeignore excludes the ${file} file`, () => {
      assert.ok(
        ignorePatterns().includes(file),
        `.vscodeignore does not exclude "${file}" - secrets would ship in the .vsix`
      );
    });
  }

  for (const dir of developmentOnlyDirs) {
    test(`.vscodeignore excludes the ${dir} directory`, () => {
      assert.ok(
        ignorePatterns().includes(`${dir}/**`),
        `.vscodeignore does not exclude "${dir}/**" - development-only files would ship in the .vsix`
      );
      assert.ok(
        fs.existsSync(path.join(findRepoRoot(), dir)),
        `expected "${dir}" to exist in the repo; the guard is stale`
      );
    });
  }
});

/**
 * Guards the marketplace icon. VS Code and Open VSX both advertise a PNG at
 * package.json#icon; a JPEG renamed to .png renders by content sniffing but
 * is not a valid PNG, so nothing downstream can be trusted to decode it.
 */
suite('Extension icon', () => {
  const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  function iconBytes(): Buffer {
    return fs.readFileSync(path.join(findRepoRoot(), 'resources', 'icon.png'));
  }

  test('resources/icon.png carries the PNG signature, not a JPEG header', () => {
    const bytes = iconBytes();
    assert.ok(
      bytes.length > 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE),
      `resources/icon.png is not a PNG (first bytes: ${bytes.subarray(0, 4).toString('hex')})`
    );
  });

  test('resources/icon.png declares its dimensions in an IHDR chunk', () => {
    const bytes = iconBytes();
    assert.strictEqual(
      bytes.toString('ascii', 12, 16),
      'IHDR',
      'resources/icon.png has no IHDR chunk, so it is not a valid PNG'
    );
    assert.strictEqual(bytes.readUInt32BE(16), 256, 'unexpected icon width');
    assert.strictEqual(bytes.readUInt32BE(20), 256, 'unexpected icon height');
  });

  test('package.json points its marketplace icon at resources/icon.png', () => {
    const root = findRepoRoot();
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    assert.strictEqual(manifest.icon, 'resources/icon.png');
    assert.ok(
      fs.existsSync(path.join(root, manifest.icon)),
      `package.json#icon points at a missing file: ${manifest.icon}`
    );
  });
});

/**
 * Guards the marketplace categories. vsce forwards `categories` to the
 * registries verbatim, so an unrecognised value only fails server-side at
 * publish time, and the catch-all "Other" listing buries the extension where
 * nobody browses for it.
 */
suite('Marketplace categories', () => {
  // The values package.json#categories accepts on both registries.
  const knownCategories = [
    'AI',
    'Azure',
    'Data Science',
    'Databases',
    'Debuggers',
    'Education',
    'Extension Packs',
    'Formatters',
    'Keymaps',
    'Language Packs',
    'Linters',
    'Machine Learning',
    'Notebooks',
    'Other',
    'Programming Languages',
    'SCM Providers',
    'Snippets',
    'Testing',
    'Themes',
    'Visualization',
  ];

  function categories(): string[] {
    const manifest = JSON.parse(fs.readFileSync(path.join(findRepoRoot(), 'package.json'), 'utf8'));
    return manifest.categories;
  }

  test('every declared category is one the registries accept', () => {
    for (const category of categories()) {
      assert.ok(
        knownCategories.includes(category),
        `"${category}" is not a known marketplace category - publishing would fail`
      );
    }
  });

  test('categories are the intended AI + Azure listing', () => {
    assert.deepStrictEqual(
      categories().slice().sort(),
      ['AI', 'Azure'],
      'unexpected marketplace categories - this list is user-visible on both registries'
    );
  });
});

/**
 * Guards the marketplace search keywords/tags. vsce's TagsProcessor unions
 * package.json#keywords into the gallery tags verbatim and validates nothing,
 * so a malformed or dishonest keyword becomes a bad listing rather than an
 * error - which is why the shape and the exact set are pinned here.
 */
suite('Marketplace keywords', () => {
  // Search terms a user realistically types for this extension, kept truthful:
  // it integrates with Azure DevOps, is an AI coding assistant, and supports
  // OpenAI/Anthropic-compatible models and MCP servers.
  const expectedKeywords = [
    'azure devops',
    'work items',
    'ai',
    'ai coding assistant',
    'agentic',
    'llm',
    'openai',
    'anthropic',
    'mcp',
    'model context protocol',
  ];

  // Names that would be keyword-squatting: this extension bundles no Copilot
  // integration and deliberately ships no code derived from Roo Code/Cline.
  const otherVendors = ['copilot', 'cline', 'roo code', 'roocode'];

  function keywords(): string[] {
    const manifest = JSON.parse(fs.readFileSync(path.join(findRepoRoot(), 'package.json'), 'utf8'));
    return manifest.keywords;
  }

  test('package.json declares an array of unique, lowercase, trimmed keywords', () => {
    const value = keywords();
    assert.ok(
      Array.isArray(value) && value.length > 0,
      'package.json#keywords must be a non-empty array'
    );
    assert.ok(value.every((k) => typeof k === 'string'), 'every keyword must be a string');
    assert.deepStrictEqual(
      value.filter((k) => k !== k.trim() || k !== k.toLowerCase()),
      [],
      'keywords must be lowercase and already trimmed'
    );
    assert.strictEqual(new Set(value).size, value.length, 'keywords must be unique');
  });

  test('keywords stay within a conservative 30-character bound', () => {
    // House bound, not a verified registry rule - it just keeps the tags short
    // and readable wherever the registries display them.
    assert.deepStrictEqual(
      keywords().filter((k) => k.length > 30),
      [],
      'keywords should stay at 30 characters or fewer'
    );
  });

  test("keywords do not squat on another product's name", () => {
    const squatted = keywords().filter((k) => otherVendors.includes(k.toLowerCase()));
    assert.deepStrictEqual(squatted, [], 'keywords must not claim another product');
  });

  test('keywords are the intended search terms', () => {
    assert.deepStrictEqual(
      keywords().slice().sort(),
      expectedKeywords.slice().sort(),
      'unexpected marketplace keywords - this list is user-visible search metadata'
    );
  });
});

/**
 * Guards chat-tab restore across IDE restarts. VS Code only revives an
 * editor-area webview panel when its view type has a registered serializer
 * (see createChatEditorSerializer in extension.ts) AND the owning extension is
 * activated on startup. `onWebviewPanel:*` is NOT auto-generated from the
 * manifest, so it must be declared explicitly or "ADO Code Chat" is silently
 * dropped when the window reloads.
 */
suite('Chat editor panel restore', () => {
  test('package.json declares onWebviewPanel for the chat editor view type', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(findRepoRoot(), 'package.json'), 'utf8'));
    const events: string[] = manifest.activationEvents || [];
    assert.ok(
      events.includes(`onWebviewPanel:${CHAT_EDITOR_VIEW_TYPE}`),
      `activationEvents must include "onWebviewPanel:${CHAT_EDITOR_VIEW_TYPE}" so the chat tab is restored on restart`
    );
  });

  test('the manifest activeWebviewType clause matches the serializer view type', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(findRepoRoot(), 'package.json'), 'utf8'));
    const raw = JSON.stringify(manifest.contributes);
    assert.ok(
      raw.includes(`activeWebviewType == '${CHAT_EDITOR_VIEW_TYPE}'`),
      'editor toolbar menus must key off the same view type the serializer restores'
    );
  });
});

