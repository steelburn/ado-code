import { parseChoiceFence, stripChoiceFence } from '../llm/parseChoicePrompt';
import type {
  RemoteDownstreamEvent,
  RemoteTranscriptEvent,
  RemoteTranscriptMessage,
} from '../shared/remoteProtocol';

/**
 * Host-side mirror of the chat thread, for the remote oversight console.
 *
 * The console is a second screen for the SAME conversation: a phone that opens
 * mid-turn, or that reloads after the screen slept, has to see what the desktop
 * webview is showing. The webview keeps its messages in React state, so the host
 * mirrors them here at the one place it already emits them — `postMessage` —
 * plus the one place a user turn enters — `handleUserMessage`. Nothing is
 * parsed twice: the assistant text is scanned with the same `parseChoiceFence`
 * the webview uses, so the phone renders the very buttons the desktop renders
 * instead of a raw fence.
 *
 * Deliberately a *display* mirror, not the LLM conversation:
 *  - thinking traces and tool cards are dropped (noise on a phone, and they
 *    would multiply the payload);
 *  - the thread is bounded (last `maxEntries`, each capped at `maxChars`) so a
 *    long session cannot turn every event into a megabyte over a tunnel;
 *  - the choice fence is stripped from `content`, because `choice` carries it
 *    structurally and rendering both would show the JSON twice.
 *
 * vscode-free on purpose: it is unit-tested without the extension host.
 */
export class TranscriptMirror {
  private readonly entries = new Map<string, RemoteTranscriptMessage>();
  private readonly order: string[] = [];
  /** Uncapped text per entry — the fence may sit past the wire cap. */
  private readonly fullText = new Map<string, string>();
  private sequence = 0;
  /** Key of the assistant message currently streaming, if any. */
  private liveKey: string | null = null;

  constructor(
    private readonly sink: (event: RemoteDownstreamEvent) => void,
    private readonly sessionId: () => string | null = () => null,
    private readonly maxEntries = 40,
    private readonly maxChars = 4000,
  ) {}

  /** A user turn entered (typed on the desktop, or sent from the phone). */
  noteUser(content: string): void {
    const text = (content ?? '').trim();
    if (!text) {
      return;
    }
    const message = this.create(`u${++this.sequence}`, 'user', text);
    this.sink({ type: 'transcriptMessage', message: { ...message } });
  }

  /**
   * Assistant text arriving from the webview's stream.
   *
   * `id` is the webview's card id when the host posts one (review cards); a
   * plain streamed answer has none, so one id is minted for the whole message
   * and reused by every delta — that is what lets the phone append in place.
   */
  noteAssistant(id: string | undefined, content: string, done: boolean): void {
    const key = id ?? (this.liveKey ??= `a${++this.sequence}`);
    let message = this.entries.get(key);
    if (!message) {
      message = this.create(key, 'assistant', '');
    }
    if (content) {
      const full = (this.fullText.get(key) ?? '') + content;
      this.fullText.set(key, full);
      if (!done) {
        message.content = this.cap(full);
        this.sink({ type: 'transcriptDelta', id: key, delta: content });
        return;
      }
    }
    // Final chunk: publish the whole message so a phone that missed deltas
    // (reconnect mid-stream) reconciles to the same text the desktop shows.
    const full = this.fullText.get(key) ?? '';
    const choice = parseChoiceFence(full);
    message.content = this.cap(stripChoiceFence(full).trim());
    if (choice && choice.options.length > 0) {
      message.choice = {
        question: choice.question,
        options: choice.options.map(option => option.label || option.value),
      };
    } else {
      delete message.choice;
    }
    this.sink({ type: 'transcriptMessage', message: { ...message } });
    if (key === this.liveKey) {
      this.liveKey = null;
    }
  }

  /**
   * Attach a choice prompt to the assistant message that offered it.
   *
   * WHY the host hands the options over instead of this class parsing them:
   * the desktop renders buttons from a `choicePrompt` frame and strips the
   * ```choice fence BEFORE the text is mirrored — and a choice can also come
   * from a plain numbered list or from the detector model. Re-parsing the
   * mirrored text therefore found nothing, so the phone showed an answer with
   * no way to answer while the desktop showed buttons.
   *
   * Idempotent: called once per prompt, and it re-publishes the message so a
   * phone that already rendered the text swaps in the buttons in place.
   */
  noteChoice(
    question: string,
    options: ReadonlyArray<string | { label?: string; value?: string }>,
    requestId?: string,
  ): void {
    const labels = (options ?? [])
      .map(option => {
        const raw = typeof option === 'string' ? option : option?.label || option?.value || '';
        return this.cap(String(raw).trim());
      })
      .filter(label => label.length > 0);
    if (labels.length === 0) {
      return;
    }
    const target = this.choiceTarget();
    if (!target) {
      return;
    }
    target.choice = {
      question: this.cap((question ?? '').trim() || 'Choose an option'),
      options: labels,
    };
    const id = (requestId ?? '').trim();
    if (id) {
      // The id is what lets an answer from EITHER surface name this block,
      // so the console's `choiceResolved` can find it later.
      target.choice.requestId = id;
    }
    this.sink({ type: 'transcriptMessage', message: { ...target } });
  }

  /**
   * Close the choice block `requestId` names with the answer that closed it.
   *
   * Returns true when THIS call closed the block. A second answer — the other
   * surface racing the first — changes nothing and announces nothing: the
   * first answer wins, because the host already started the turn from it.
   */
  resolveChoice(requestId: string, answer: string, source: 'host' | 'remote'): boolean {
    const id = (requestId ?? '').trim();
    const picked = this.cap((answer ?? '').trim());
    if (!id || !picked) {
      return false;
    }
    for (const key of this.order) {
      const message = this.entries.get(key);
      if (!message?.choice || message.choice.requestId !== id || message.choice.answered) {
        continue;
      }
      message.choice.answer = picked;
      message.choice.answered = true;
      // Re-publish first so a console that missed the tap swaps the live
      // buttons for the answered block, then announce the closure.
      this.sink({
        type: 'transcriptMessage',
        message: { ...message, choice: { ...message.choice } },
      });
      this.sink({
        type: 'choiceResolved',
        requestId: id,
        messageId: message.id,
        answer: picked,
        source,
      });
      return true;
    }
    return false;
  }

  /** The message a choice belongs to: the live stream, else the newest answer. */
  private choiceTarget(): RemoteTranscriptMessage | null {
    if (this.liveKey) {
      const live = this.entries.get(this.liveKey);
      if (live) {
        return live;
      }
    }
    for (let index = this.order.length - 1; index >= 0; index--) {
      const message = this.entries.get(this.order[index]);
      if (message?.role === 'assistant') {
        return message;
      }
    }
    return null;
  }

  /** Session switched, or history restored: replace the whole thread. */
  reset(messages: Array<{ role?: unknown; content?: unknown }>): void {
    this.entries.clear();
    this.order.length = 0;
    this.fullText.clear();
    this.liveKey = null;
    for (const row of messages ?? []) {
      if (row?.role !== 'user' && row?.role !== 'assistant') {
        continue;
      }
      if (typeof row.content !== 'string' || !row.content.trim()) {
        continue;
      }
      const id = `${row.role === 'user' ? 'u' : 'a'}${++this.sequence}`;
      const message = this.create(id, row.role, row.content);
      if (row.role === 'assistant') {
        const choice = parseChoiceFence(row.content);
        message.content = this.cap(stripChoiceFence(row.content).trim());
        if (choice && choice.options.length > 0) {
          message.choice = {
            question: choice.question,
            options: choice.options.map(option => option.label || option.value),
          };
        }
      }
    }
    this.sink(this.snapshot());
  }

  /** Full transcript, for `GET /transcript` replay on every (re)connect. */
  snapshot(): RemoteTranscriptEvent {
    return {
      type: 'transcript',
      sessionId: this.sessionId(),
      messages: this.order
        .map(key => this.entries.get(key))
        .filter((message): message is RemoteTranscriptMessage => Boolean(message))
        .map(message => ({ ...message })),
    };
  }

  private create(id: string, role: 'user' | 'assistant', content: string): RemoteTranscriptMessage {
    const message: RemoteTranscriptMessage = { id, role, content: this.cap(content) };
    this.entries.set(id, message);
    this.order.push(id);
    while (this.order.length > this.maxEntries) {
      const dropped = this.order.shift();
      if (dropped) {
        this.entries.delete(dropped);
        this.fullText.delete(dropped);
      }
    }
    return message;
  }

  private cap(text: string): string {
    if (text.length <= this.maxChars) {
      return text;
    }
    return `${text.slice(0, this.maxChars)}…`;
  }
}
