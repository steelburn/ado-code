import { parseChoiceFence, stripChoiceFence } from '../llm/parseChoicePrompt';
import { MAX_MESSAGE_TOOLS } from '../shared/remoteProtocol';
import type {
  RemoteDownstreamEvent,
  RemoteTranscriptChoice,
  RemoteTranscriptEvent,
  RemoteTranscriptMessage,
  RemoteToolActivity,
} from '../shared/remoteProtocol';

/** Bound on the answer registry: an answer nothing can reach is only a leak. */
const MAX_REMEMBERED_ANSWERS = 64;

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
  /**
   * Questions already answered, keyed by requestId AND — for a block that has
   * to be rebuilt from raw text and so lost its id (history restore, a
   * re-streamed message) — by its question+options signature.
   *
   * Without this every rebuild (the final stream chunk, a second noteChoice, a
   * history restore, a reconnect snapshot) hands the phone a fresh, live
   * choice block and re-renders options that were already picked as "waiting
   * for input", tappable a second time.
   */
  private readonly answers = new Map<string, string>();
  /** Session the registry belongs to — an answer never crosses sessions. */
  private answersSession: string | null = null;
  private sequence = 0;
  /** Key of the assistant message of the CURRENT turn — where tools hang. */
  private turnKey: string | null = null;
  /** Key of the content-less message holding calls made before any text. */
  private toolGroupKey: string | null = null;
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
    // A new turn opened: the previous turn's assistant message and tool group
    // are closed, so this turn's calls get their own home.
    this.turnKey = null;
    this.toolGroupKey = null;
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
    // Assistant text arrived in this turn: later tool calls hang under it.
    this.turnKey = key;
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
      // Rebuilt from the text, so it has no id of its own: carry the identity
      // (and the answer, if there is one) of the block it replaces.
      message.choice = this.buildChoice(
        choice.question,
        choice.options.map(option => option.label || option.value),
        undefined,
        message.choice,
      );
    } else if (message.choice) {
      // The fence is gone from the text (the webview strips it before posting):
      // keep the block the phone already has — deleting it would drop an
      // answered card, and re-creating it would offer a dead prompt again.
      message.choice = this.buildChoice(
        message.choice.question,
        message.choice.options,
        undefined,
        message.choice,
      );
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
    const id = (requestId ?? '').trim();
    // The id is what lets an answer from EITHER surface name this block, so the
    // console's `choiceResolved` can find it later. A prompt that was already
    // answered (a replayed turn, a retry of the same card) must come back
    // CLOSED: re-offering its options starts the question a second time.
    target.choice = this.buildChoice(
      this.cap((question ?? '').trim() || 'Choose an option'),
      labels,
      id || undefined,
      target.choice,
    );
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
      // Remember it: any later rebuild of this block reads from here, so the
      // phone cannot be shown the options as open again.
      this.rememberAnswer(message.choice.question, message.choice.options, id, picked);
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

  /** Identity of one prompt, for a rebuild that lost the requestId. */
  private static choiceSignature(question: string, options: readonly string[]): string {
    return `${question.trim().toLowerCase()}\u0000${options.join('\u0000')}`;
  }

  /** The registry dies with its session: a switch starts with a clean slate. */
  private forgetForeignAnswers(): void {
    const session = this.sessionId();
    if (session !== this.answersSession) {
      this.answers.clear();
      this.answersSession = session;
    }
  }

  /** Record an answer so every later rebuild of the same block stays closed. */
  private rememberAnswer(
    question: string,
    options: readonly string[],
    requestId: string | undefined,
    answer: string,
  ): void {
    this.forgetForeignAnswers();
    if (requestId) {
      this.answers.set(requestId, answer);
    }
    this.answers.set(TranscriptMirror.choiceSignature(question, options), answer);
    while (this.answers.size > MAX_REMEMBERED_ANSWERS) {
      const oldest = this.answers.keys().next();
      if (oldest.done) {
        break;
      }
      this.answers.delete(oldest.value);
    }
  }

  /**
   * The phone's view of one choice block, carrying the identity and the answer
   * of the block it replaces.
   *
   * An id the registry knows to be answered stays answered. A block WITHOUT an
   * id — rebuilt from raw text — falls back to its signature, because a live
   * prompt always carries a requestId and must stay live even if the model asks
   * the very same question again.
   */
  private buildChoice(
    question: string,
    options: string[],
    requestId?: string,
    previous?: RemoteTranscriptChoice,
  ): RemoteTranscriptChoice {
    const choice: RemoteTranscriptChoice = { question, options };
    const id = requestId ?? previous?.requestId;
    if (id) {
      choice.requestId = id;
    }
    let picked = id ? this.answers.get(id) : undefined;
    if (picked === undefined && !id) {
      picked = this.answers.get(TranscriptMirror.choiceSignature(question, options));
    }
    if (picked === undefined && !requestId && previous?.answered) {
      picked = previous.answer;
    }
    if (picked !== undefined) {
      choice.answer = picked;
      choice.answered = true;
    }
    return choice;
  }

  /** Session switched, or history restored: replace the whole thread. */
  reset(messages: Array<{ role?: unknown; content?: unknown }>): void {
    this.forgetForeignAnswers();
    this.entries.clear();
    this.turnKey = null;
    this.toolGroupKey = null;
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
          // Restored from the raw text, which carries no requestId: the answer
          // registry (by signature) is what keeps a restored, already-answered
          // prompt closed instead of live again.
          message.choice = this.buildChoice(
            choice.question,
            choice.options.map(option => option.label || option.value),
          );
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

  /**
   * A tool call the agent made, hung under the assistant message it belongs to.
   *
   * The console mirrors the CONVERSATION, so a call belongs where the webview
   * draws its card: after the assistant text that asked for it. A turn that
   * calls a tool before writing anything gets a content-less message of its own
   * — the console renders that as a tool group, never as an empty bubble.
   *
   * Upserted by call id: the loop announces every call twice (started, then
   * settled) and the thread must show one row per call, not two.
   */
  noteTool(activity: RemoteToolActivity): void {
    if (!activity || typeof activity.id !== 'string' || !activity.id) {
      return;
    }
    const target = this.toolTarget();
    const tools = target.tools ?? (target.tools = []);
    const at = tools.findIndex(row => row.id === activity.id);
    if (at >= 0) {
      tools[at] = activity;
    } else {
      tools.push(activity);
      target.toolCount = (target.toolCount ?? 0) + 1;
    }
    if (tools.length > MAX_MESSAGE_TOOLS) {
      // Oldest first: a phone wants the calls that just ran, and toolCount
      // keeps the real total so the console can say what it is not showing.
      tools.splice(0, tools.length - MAX_MESSAGE_TOOLS);
    }
    this.sink({
      type: 'transcriptMessage',
      message: { ...target, tools: tools.map(row => ({ ...row })) },
    });
  }

  /** The message a tool call hangs under (see noteTool). */
  private toolTarget(): RemoteTranscriptMessage {
    if (this.turnKey) {
      const message = this.entries.get(this.turnKey);
      if (message) {
        return message;
      }
    }
    // Calls made before this turn wrote any text: one group message, reused for
    // the rest of the turn so they do not each get a bubble of their own.
    if (this.toolGroupKey) {
      const group = this.entries.get(this.toolGroupKey);
      if (group) {
        return group;
      }
    }
    const key = `t${++this.sequence}`;
    this.toolGroupKey = key;
    return this.create(key, 'assistant', '');
  }

  private cap(text: string): string {
    if (text.length <= this.maxChars) {
      return text;
    }
    return `${text.slice(0, this.maxChars)}…`;
  }
}
