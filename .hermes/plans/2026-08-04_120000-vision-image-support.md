# Vision / Image Support Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Make pasted images actually reach the LLM as vision data so the AI assistant can see and discuss them.

**Architecture:** Four-layer pipeline fix: (1) Webview sends image data over postMessage, (2) Extension host builds Anthropic-style content blocks, (3) Old providers (active code path) convert to native API format, (4) OpenAI provider sends `image_url` parts. The `BaseProvider.ContentBlockImage` type already exists but is unused by the active providers — we wire the pipeline through the OLD providers that are actually in use.

**Tech Stack:** TypeScript, React (webview), VS Code postMessage API, Anthropic Messages API, OpenAI Chat Completions API.

---

## Problem Summary

When a developer pastes an image into the chat, `InputBar.tsx` captures it as a data URL but `handleSend()` discards the data and sends only a text placeholder: `[Image: filename.png]`. The AI then says "I can't see the image" because no image data reaches the LLM.

**Active code path (old providers):**
```
InputBar.tsx → App.tsx handleSend → postMessage('userMessage', content:string)
  → ChatViewProvider.handleUserMessage(content:string)
    → LlmClient.chatWithTools(messages:LlmMessage[], ...)
      → OpenAiProvider.chatWithTools / AnthropicProvider.chatWithTools
        → API request with {role, content: string}
```

**Break points:**
1. `InputBar.tsx:264` — converts images to `[Image: name]` text, throws away base64
2. `App.tsx:263` — `postMessage({type:'userMessage', content})` sends string only
3. `messages.ts:5` — `userMessage` type has `content: string`, no images
4. `LlmMessage` (types.ts:3) — `content: string`, no image blocks
5. `ChatViewProvider.ts:952` — `handleUserMessage(content: string)` receives text only
6. `AnthropicProvider.streamChat:11` — converts messages to `{content: string}` only
7. `OpenAiProvider.chatWithTools:82` — sends `{role, content: m.content}` as string

---

## Task 1: Extend Message Protocol for Images

**Objective:** Add image attachment types to the shared message protocol so images can travel from webview to extension host.

**Files:**
- Modify: `src/shared/messages.ts` — add `ImageAttachment` interface and `images` field to `userMessage`
- Modify: `src/webview-ui/src/types.ts` — mirror the same change for the webview copy

**Step 1: Add ImageAttachment interface to shared messages.ts**

At the top of `src/shared/messages.ts`, before the `WebviewToExtensionMessage` type, add:

```typescript
/** An image pasted into the chat, carried as a base64 data URL. */
export interface ImageAttachment {
  id: string;
  /** data:image/png;base64,<encoded> or data:image/jpeg;base64,<encoded> */
  dataUrl: string;
  /** Original filename or auto-generated name */
  name: string;
}
```

**Step 2: Add images field to userMessage type**

In `WebviewToExtensionMessage`, change the `userMessage` variant from:
```typescript
| { type: 'userMessage'; content: string; context?: MessageContext }
```
to:
```typescript
| { type: 'userMessage'; content: string; context?: MessageContext; images?: ImageAttachment[] }
```

**Step 3: Mirror in webview types.ts**

Apply the exact same `ImageAttachment` interface and `images?: ImageAttachment[]` field to `src/webview-ui/src/types.ts`.

**Step 4: Compile check**

Run: `npm run compile`
Expected: clean compilation (new interface + optional field = no breakage)

---

## Task 2: Send Image Data from Webview

**Objective:** Modify InputBar and App to actually send image data (base64) over postMessage instead of discarding it.

**Files:**
- Modify: `src/webview-ui/src/components/InputBar.tsx` — change `onSend` to pass images
- Modify: `src/webview-ui/src/App.tsx` — pass images through the postMessage call

**Step 1: Update InputBar Props and handleSend**

In `InputBar.tsx`, change the `onSend` prop signature from:
```typescript
onSend: (content: string) => void;
```
to:
```typescript
onSend: (content: string, images?: ImageAttachment[]) => void;
```

Update `handleSend` (line ~257) to pass images instead of converting to text:
```typescript
const handleSend = useCallback(() => {
  const trimmed = value.trim();
  if (!trimmed && images.length === 0) return;
  if (loading) return;

  onSend(trimmed, images.length > 0 ? images : undefined);

  // Add to history
  if (trimmed) {
    setHistory(prev => {
      const newHistory = [trimmed, ...prev.filter(h => h !== trimmed)];
      return newHistory.slice(0, 50);
    });
  }

  // Reset
  setImages([]);
  setHistoryIndex(-1);
  if (textareaRef.current) textareaRef.current.style.height = 'auto';
}, [value, images, loading, onSend]);
```

**Step 2: Update App.tsx handleSend**

In `App.tsx`, update `handleSend` to accept and forward images:
```typescript
import type { ImageAttachment } from './types';

// ...

const handleSend = useCallback((content: string, images?: ImageAttachment[]) => {
  // Display placeholder in chat history (images are not rendered inline)
  const displayContent = images?.length
    ? (content ? `${content}\n\n${images.map(i => `[Image: ${i.name}]`).join(' ')}` : images.map(i => `[Image: ${i.name}]`).join(' '))
    : content;
  setMessages(prev => [...prev, { role: 'user', content: displayContent }]);
  vscode.postMessage({ type: 'userMessage', content, images });
  setDraft('');
  setLoading(true);
  setConsent(null);
}, []);
```

**Step 3: Compile check**

Run: `npm run compile`
Expected: clean compilation

---

## Task 3: Extend LlmMessage to Support Image Content Blocks

**Objective:** Allow `LlmMessage` to carry content as either a string or an array of content blocks (text + image).

**Files:**
- Modify: `src/llm/types.ts` — extend `LlmMessage.content` to accept content block arrays

**Step 1: Extend LlmMessage in types.ts**

The `LlmMessage` interface needs its `content` field to accept both strings and content block arrays. We reuse the existing `ContentBlockParam` type from `BaseProvider.ts`:

```typescript
import type { ContentBlockParam } from './providers/BaseProvider';

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentBlockParam[];
  toolCallId?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
}
```

This is a union type — all existing code passes `string` and continues to work. Only the new image path will use `ContentBlockParam[]`.

**Step 2: Compile check**

Run: `npm run compile`
Expected: may show type errors in providers that assume `content` is a string — those are fixed in Tasks 4-5.

---

## Task 4: Fix AnthropicProvider — Native Image Support

**Objective:** Update the old AnthropicProvider to handle `ContentBlockParam[]` content and send image blocks to the Anthropic API natively.

**Files:**
- Modify: `src/llm/providers/anthropic.ts` — update `streamChat` and `chatWithTools`

**Step 1: Update streamChat to handle ContentBlockParam[]**

In `streamChat`, the current code at line 11 converts messages to `{role, content: string}`. When `m.content` is a `ContentBlockParam[]`, it should be sent as-is (Anthropic's native format).

Replace the message conversion loop (lines 11-20):
```typescript
const anthropicMessages: Array<{ role: 'user' | 'assistant'; content: string | ContentBlockParam[] }> = [];
for (const m of nonSystemMessages) {
  const role = m.role as 'user' | 'assistant';
  const last = anthropicMessages[anthropicMessages.length - 1];
  if (last && last.role === role) {
    // Merge same-role: if both are strings, concatenate; if content blocks, merge arrays
    if (typeof last.content === 'string' && typeof m.content === 'string') {
      last.content += '\n\n' + m.content;
    } else {
      const lastBlocks = typeof last.content === 'string'
        ? [{ type: 'text' as const, text: last.content }]
        : last.content;
      const newBlocks = typeof m.content === 'string'
        ? [{ type: 'text' as const, text: m.content }]
        : m.content;
      last.content = [...lastBlocks, ...newBlocks];
    }
  } else {
    anthropicMessages.push({ role, content: m.content });
  }
}
```

Add import at top:
```typescript
import type { ContentBlockParam } from './BaseProvider';
```

**Step 2: Update chatWithTools message handling**

In `chatWithTools`, the user message handling (lines 131-136) currently assumes `m.content` is a string. Update the last else branch:

```typescript
// Replace lines 131-136
const last = anthropicMessages[anthropicMessages.length - 1];
if (last && last.role === role) {
  // Merge same-role messages
  if (typeof last.content === 'string' && typeof m.content === 'string') {
    last.content += '\n\n' + m.content;
  } else {
    const lastBlocks = typeof last.content === 'string'
      ? [{ type: 'text' as const, text: last.content }]
      : (Array.isArray(last.content) ? last.content : [last.content]);
    const newBlocks = typeof m.content === 'string'
      ? [{ type: 'text' as const, text: m.content }]
      : (Array.isArray(m.content) ? m.content : [m.content]);
    last.content = [...lastBlocks, ...newBlocks];
  }
} else {
  anthropicMessages.push({ role, content: m.content });
}
```

**Step 3: Compile check**

Run: `npm run compile`
Expected: clean compilation

---

## Task 5: Fix OpenAIProvider — Convert Images to image_url Format

**Objective:** Update the old OpenAIProvider to handle `ContentBlockParam[]` content and convert image blocks to OpenAI's `image_url` format.

**Files:**
- Modify: `src/llm/providers/openai.ts` — update `streamChat` and `chatWithTools`

**Step 1: Add image conversion helper**

Add a helper function at the bottom of `openai.ts`:

```typescript
import type { ContentBlockParam } from './BaseProvider';

/** Convert ContentBlockParam[] to OpenAI content format (string or array of parts). */
function convertContent(
  content: string | ContentBlockParam[],
): string | Array<{ type: string; text?: string; image_url?: { url: string } }> {
  if (typeof content === 'string') {
    return content;
  }
  const parts: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];
  for (const block of content) {
    if (block.type === 'text') {
      parts.push({ type: 'text', text: block.text });
    } else if (block.type === 'image') {
      const { source } = block;
      let url: string | undefined;
      if (source.type === 'base64' && source.data) {
        url = `data:${source.media_type};base64,${source.data}`;
      } else if (source.type === 'url' && source.url) {
        url = source.url;
      }
      if (url) {
        parts.push({ type: 'image_url', image_url: { url } });
      }
    }
  }
  // If only text parts, collapse to string for simpler API calls
  if (parts.every(p => p.type === 'text')) {
    return parts.map(p => p.text).join('\n');
  }
  return parts;
}
```

**Step 2: Update streamChat message mapping**

In `streamChat`, the messages are passed directly to the API (line 14). Since OpenAI's Chat Completions API accepts `{role, content}` where content can be a string or array, we need to convert `LlmMessage[]` to the proper format.

Replace the messages in the body:
```typescript
async *streamChat(messages: LlmMessage[], config: LlmConfig, signal?: AbortSignal): AsyncGenerator<LlmStreamChunk> {
  const openaiMessages = messages
    .filter(m => m.role !== 'tool') // tool messages not in streamChat
    .map(m => ({ role: m.role, content: convertContent(m.content) }));

  const response = await fetch(`${config.apiUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
    },
    signal,
    body: JSON.stringify({
      model: config.model,
      messages: openaiMessages,
      stream: true,
    }),
  });
  // ... rest unchanged
```

**Step 3: Update chatWithTools message mapping**

In `chatWithTools`, update the `nativeMessages` mapping (lines 67-83):

```typescript
const nativeMessages = messages.map(m => {
  if (m.role === 'tool' && m.toolCallId) {
    return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
  }
  if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
    return {
      role: 'assistant',
      content: convertContent(m.content),
      tool_calls: m.toolCalls.map(tc => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: tc.arguments },
      })),
    };
  }
  return { role: m.role, content: convertContent(m.content) };
});
```

**Step 4: Compile check**

Run: `npm run compile`
Expected: clean compilation

---

## Task 6: Wire Images in ChatViewProvider

**Objective:** Build `ContentBlockParam[]` from pasted images and pass them into the LLM message pipeline.

**Files:**
- Modify: `src/webview/ChatViewProvider.ts` — build image blocks in `handleUserMessage`

**Step 1: Update message handler dispatch**

In the `onDidReceiveMessage` handler (line 275-276), update to pass images:
```typescript
case 'userMessage':
  await this.handleUserMessage(message.content, message.images);
  break;
```

**Step 2: Update handleUserMessage to build ContentBlockParam[]**

Add imports at top:
```typescript
import type { ContentBlockParam } from '../llm/providers/BaseProvider';
import type { ImageAttachment } from '../shared/messages';
```

Update the method signature and body:
```typescript
private async handleUserMessage(content: string, images?: ImageAttachment[]): Promise<void> {
  // Task 14: slash-command parsing BEFORE sending to the LLM.
  const parsed = parseSlashCommand(content);
  if (parsed) {
    await this.executeSlashCommand(parsed.command.name, parsed.args);
    return;
  }

  // Task 16: inject active file + selection context
  const contextBlock = this.buildEditorContext();

  // Build LLM content: string or ContentBlockParam[] if images present
  let llmContent: string | ContentBlockParam[];
  if (images && images.length > 0) {
    const blocks: ContentBlockParam[] = [];
    // Text block (with editor context prepended if available)
    const textContent = contextBlock
      ? `${contextBlock}\n\n[User message:]\n${content}`
      : content;
    if (textContent.trim()) {
      blocks.push({ type: 'text', text: textContent });
    }
    // Image blocks
    for (const img of images) {
      const match = img.dataUrl.match(/^data:(image\/\w+);base64,(.+)$/);
      if (match) {
        blocks.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: match[1],
            data: match[2],
          },
        });
      }
    }
    llmContent = blocks;
  } else {
    llmContent = contextBlock
      ? `${contextBlock}\n\n[User message:]\n${content}`
      : content;
  }

  // Cancel any in-flight stream before starting a new one
  this.llmAbort?.abort();
  const abort = new AbortController();
  this.llmAbort = abort;

  // ... mode dispatch unchanged ...
  this.conversation.push({ role: 'user', content: llmContent });
  this.trimConversation();
  // ... rest of method unchanged ...
}
```

**Step 3: Compile check**

Run: `npm run compile`
Expected: clean compilation

---

## Task 7: Session Persistence — Handle ContentBlockParam[] in Serialization

**Objective:** Ensure that conversation persistence (session store) handles the new union type without breaking.

**Files:**
- Modify: `src/webview/ChatViewProvider.ts` — update persistence methods

**Step 1: Update persistConversation to serialize properly**

The `Session.messages` type is `{role: string; content: string}[]`. When persisting, convert `ContentBlockParam[]` to a text summary.

Find the `persistConversation` method and update the serialization:

```typescript
private async persistConversation(): Promise<void> {
  const session = this.getSessions().find(s => s.id === this.getActiveSessionId());
  if (!session) return;
  session.messages = this.conversation.map(m => ({
    role: m.role,
    content: typeof m.content === 'string'
      ? m.content
      : m.content
          .filter((b): b is import('../llm/providers/BaseProvider').ContentBlockText => b.type === 'text')
          .map(b => b.text)
          .join('') || '(image attached)',
  }));
  await this.saveSessions(this.getSessions());
}
```

Note: The exact syntax may need adjustment based on how `persistConversation` currently works. The key point is: text-only for storage, full blocks for LLM.

**Step 2: Compile check**

Run: `npm run compile`
Expected: clean compilation

---

## Task 8: Build and Package Verification

**Objective:** Full end-to-end build verification.

**Files:** None (verification only)

**Step 1: TypeScript compilation**

Run: `npm run compile`
Expected: clean, no errors

**Step 2: Webview build**

Run: `npm run build:webview`
Expected: clean webpack bundle

**Step 3: Full build**

Run: `npm run build:all`
Expected: both compile and webview succeed

**Step 4: Lint**

Run: `npm run lint`
Expected: no lint errors (new warnings acceptable if pre-existing)

**Step 5: Run tests**

Run: `npm test`
Expected: all existing tests pass

---

## Files Changed Summary

| File | Change |
|------|--------|
| `src/shared/messages.ts` | Add `ImageAttachment` interface, add `images?` to `userMessage` |
| `src/webview-ui/src/types.ts` | Mirror `ImageAttachment` + `images?` field |
| `src/webview-ui/src/components/InputBar.tsx` | Send images via `onSend` callback |
| `src/webview-ui/src/App.tsx` | Forward images in `postMessage`, display placeholder in chat |
| `src/llm/types.ts` | Extend `LlmMessage.content` to `string \| ContentBlockParam[]` |
| `src/llm/providers/anthropic.ts` | Handle `ContentBlockParam[]` in `streamChat` and `chatWithTools` |
| `src/llm/providers/openai.ts` | Add `convertContent()` helper, handle images in both methods |
| `src/webview/ChatViewProvider.ts` | Build `ContentBlockParam[]` from images, update dispatch + persistence |

## Risks & Tradeoffs

1. **Base64 size in postMessage**: Pasted screenshots can be 1-5 MB as base64. VS Code postMessage handles this fine (no serialization limit), but very large images (>10 MB) could slow things down. Consider adding a max-size check and compression in a future iteration.

2. **LLM token cost**: Images are expensive (~1000+ tokens each). No mitigation in this plan — the user implicitly opts in by pasting.

3. **Session restore**: Old sessions without images continue to work (string content). New sessions with images store text-only summaries — the LLM won't re-see images on restore. This is acceptable; image context is ephemeral.

4. **Model compatibility**: Not all models support vision. The old providers don't have `supportsImages` checks. A future enhancement could warn the user. Out of scope.

5. **Old providers are the active path**: The v2 providers (`AnthropicV2Provider`, `OpenAiV2Provider`) and `handler.ts` are NOT wired into `client.ts`. This plan targets the OLD providers that are actually in use.

6. **ContentBlockParam import**: `types.ts` importing from `providers/BaseProvider.ts` creates a dependency. Verify this doesn't cause circular imports (it shouldn't — BaseProvider has no imports from types.ts).

## Open Questions

- Should we add image preview in the chat bubble (show the pasted image thumbnail)? Currently the chat shows `[Image: name]` text. This would be a UX improvement but adds complexity.
- Should we add a max image size limit with client-side compression? For v1, we skip this.
