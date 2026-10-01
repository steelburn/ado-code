import React, { useState, useEffect, useCallback, useRef } from 'react';
import { ExtensionToWebviewMessage, WebviewToExtensionMessage, Session, SessionRunInfo, ImageAttachment, StoredTurnTrace } from './types';
import { WelcomeScreen } from './components/WelcomeScreen';
import { TaskDetailPanel } from './components/TaskDetailPanel';
import { MessageList, LiveTraceEntry, TraceEntry, TraceInput } from './components/MessageList';
import { InputBar } from './components/InputBar';
import { StatusLine } from './components/StatusLine';
import { KebabMenu } from './components/KebabMenu';
import { collapseAllActionLabel } from '../../shared/chatNavigation';
import { normalizeDensity, cycleDensity, densityLabel } from '../../shared/chatDensity';
import { ProjectSwitcher } from './components/ProjectSwitcher';
import { AgentOutputPanel } from './components/AgentOutputPanel';
import { ConsentCard, ConsentRequest } from './components/ConsentCard';
import { ConfirmationCard, ConfirmationRequest } from './components/ConfirmationCard';
import { SessionHistory } from './components/SessionHistory';
import { ConfigurationPage } from './components/ConfigurationPage';
import { ProjectCreationWizard } from './components/ProjectCreationWizard';
import { SkillCatalog } from './components/SkillCatalog';
import { vscode } from './vscode';
import { ErrorBanner } from './components/common/ErrorBanner';
import './styles/app.css';
import './styles/markdown.css';

interface SanitizedConfig {
  adoOrganization: string;
  adoProject: string;
  llmProvider: string;
  llmApiUrl: string;
  llmModel: string;
  mode?: 'inline' | 'plan' | 'act' | 'yolo';
  configured: boolean;
  /** ADO is optional — false when the user skipped it in the setup wizard. */
  adoConfigured?: boolean;
  adoConnectionConfigured?: boolean;
  modelCapabilities?: { vision: boolean; tools: boolean };
  isEditor?: boolean;
  /** Default behavior when the user sends a message while the AI is processing. */
  chatInputWhileBusy?: 'steer' | 'queue';
  /** Item 5: chat density mirrored from the host setting (comfortable | compact | answers-only). */
  chatDensity?: string;
}

interface AgentInfo {
  name: string;
  displayName: string;
  installed: boolean;
}

interface WorkItemDetail {
  id: number;
  title: string;
  state: string;
  workItemType: string;
  assignedTo: string;
  creator?: string;
  description?: string;
  acceptanceCriteria?: string;
  tags?: string;
  areaPath?: string;
  iterationPath?: string;
  comments?: Array<any>;
}

/** Cap an over-long payload kept in a finished turn's record so a huge tool
 *  result or chain-of-thought can't bloat the message. */
function capRecord(text: string | undefined, limit: number): string | undefined {
  if (text === undefined) return undefined;
  return text.length > limit ? text.slice(0, limit) + '\n…(truncated)' : text;
}

/** One chat message as the thread renders it: the ordered Thinking/Tools
 *  record travels with the assistant message it belongs to. */
interface ChatMessage {
  role: string;
  content: string;
  id?: string;
  // Steer-mode messages: rendered optimistically when typed mid-run; `steered`
  // flips true once the host confirms the loop picked the text up.
  steering?: boolean;
  steered?: boolean;
  trace?: TraceInput;
  traceTruncated?: boolean;
}

/**
 * Rebuild chat messages from a session record (sessionList / sessionSwitched
 * payloads), carrying the persisted Thinking/Tools record onto the chat message.
 * Entries are un-nested here: a stored trace is `{ entries, truncated }`, while
 * the chat message holds just the ordered segments.
 */
function restoredMessages(
  stored: Array<{ role: string; content: string; trace?: StoredTurnTrace }>
): ChatMessage[] {
  return stored.map(m => ({
    role: m.role,
    content: m.content,
    ...(m.trace && m.trace.entries.length > 0
      ? { trace: m.trace.entries, ...(m.trace.truncated ? { traceTruncated: true } : {}) }
      : {}),
  }));
}

function App() {
  // ── State ──────────────────────────────────────────────────────
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [config, setConfig] = useState<SanitizedConfig | null>(null);
  // Messages the user sent while the AI was still working (queue behavior).
  const [queued, setQueued] = useState<Array<{ id: string; fullContent: string; displayContent: string; images?: ImageAttachment[] }>>([]);
  // Whether a message sent mid-turn steers the current run or waits its turn.
  const [inputWhileBusy, setInputWhileBusy] = useState<'steer' | 'queue'>('steer');
  // Agent delegations the model suggested for the current answer.
  const [delegationSuggestions, setDelegationSuggestions] = useState<Array<{ agent: string; reason: string; prompt: string }>>([]);
  const [mode, setMode] = useState('inline');
  const [detail, setDetail] = useState<WorkItemDetail | null>(null);
  const [chatMovedToEditor, setChatMovedToEditor] = useState(false);
  // Ordered live trace of the current turn: thinking blocks and tool cards in
  // the order the loop produced them. Each complete reasoning step from the
  // agentic loop (newBlock) is its own entry, so thinking stays BETWEEN the
  // tool batches it introduced — never glued into a single blob above them.
  const [liveTrace, setLiveTrace] = useState<LiveTraceEntry[]>([]);
  // Mirror of liveTrace for the (stale-closure) message handler — the
  // useEffect below mounts once, so plain state reads there are frozen.
  const traceRef = useRef<LiveTraceEntry[]>([]);
  // Stable keys for thinking blocks (tool blocks key on their call id).
  const thinkingSeqRef = useRef(0);
  const commitLiveTrace = useCallback((next: LiveTraceEntry[]) => {
    traceRef.current = next;
    setLiveTrace(next);
  }, []);
  // Answer text streamed by the CURRENT turn, buffered in the live bubble: it
  // renders in-flow UNDER the reasoning + tool cards (reasoning flows up and
  // scrolls away naturally instead of pinning a fixed box at the bottom) and
  // materializes as a normal assistant message when the turn completes.
  const [streamText, setStreamText] = useState('');
  const streamTextRef = useRef('');

  /** Drop everything that only exists while a turn is live (ordered trace of
   *  thinking/tool segments, buffered stream, activity label). Called on
   *  completion, errors, new sends, and session switches. */
  const finishTurnState = useCallback(() => {
    setLiveTrace([]);
    traceRef.current = [];
    setStreamText('');
    streamTextRef.current = '';
    setActiveActivity(null);
  }, []);

  // Agent state — supports multiple concurrent runs
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [agentRuns, setAgentRuns] = useState<Map<string, { run: any; output: string }>>(new Map());
  const [projects, setProjects] = useState<Array<{ id: string; name: string; state: string }>>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  // Input draft lives in App so toolbar tools (add context / attach files) can
  // append to it; InputBar renders it controlled.
  const [draft, setDraft] = useState('');
  // Pending attached files from context menu (right-click → send file to chat)
  const [attachedFiles, setAttachedFiles] = useState<Array<{ name: string; content: string }>>([]);
  // Pending consent: the agent (inline mode) wants to run a mutating tool.
  const [consent, setConsent] = useState<ConsentRequest | null>(null);
  // Pending confirmation: in-chat card replacing native VS Code dialogs,
  // tracked per session so switching away and back preserves open prompts.
  const [confirmationsBySession, setConfirmationsBySession] = useState<Record<string, ConfirmationRequest | null>>({});
  const confirmationsBySessionRef = useRef<Record<string, ConfirmationRequest | null>>({});
  // Wizard model picker (LLM provider) — ids + optional live capability hints
  const [models, setModels] = useState<Array<{ id: string; vision?: boolean; tools?: boolean }>>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  // Ensures the main-view project switcher fetches the org project list once
  // per webview session (message-handler closures are stale, so a ref, not
  // state, gates the one-shot fetch).
  const projectsRequestedRef = useRef(false);

  // Session history
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  // Which session (if any) still owns the in-flight turn — drives the running
  // badge in the session list while its work happens in the background.
  const [sessionRun, setSessionRun] = useState<SessionRunInfo | null>(null);
  const activeSessionIdRef = useRef<string | null>(null);

  const currentSessionKey = activeSessionId || 'default';
  const confirmation = confirmationsBySession[currentSessionKey] ?? null;

  // Configuration page
  const [showConfig, setShowConfig] = useState(false);
  // ADO-not-configured reminder banner (dismissed per webview session).
  const [adoReminderDismissed, setAdoReminderDismissed] = useState(false);
  // Project creation wizard
  const [showProjectWizard, setShowProjectWizard] = useState(false);
  // Creation failure shown INSIDE the wizard (App-level, so it survives the
  // fixed overlay that would hide the global error banner).
  const [projectWizardError, setProjectWizardError] = useState<string | null>(null);
  // Skill catalog
  const [showSkillCatalog, setShowSkillCatalog] = useState(false);
  // Activity indicator — shows a banner while a skill is executing or tasks are generating
  const [activeActivity, setActiveActivity] = useState<string | null>(null);

  // ── Message handler ────────────────────────────────────────────
  useEffect(() => {
    const handler = (event: MessageEvent<ExtensionToWebviewMessage>) => {
      const msg = event.data;
      switch (msg.type) {
        case 'steeringApplied': {
          // The running turn picked up a steered message — flip its marker from
          // "steering…" to "steered into run". The bubble already exists.
          setMessages(prev => {
            for (let k = prev.length - 1; k >= 0; k--) {
              const cur = prev[k];
              if (cur && cur.steering && !cur.steered) {
                const copy = [...prev];
                copy[k] = { ...cur, steered: true };
                return copy;
              }
            }
            return prev;
          });
          break;
        }
        case 'steeringQueued':
          // Ack only — the bubble is already rendered optimistically.
          break;
        case 'assistantMessage':
          // ── ID-stamped bubbles (evolving run card) ─────────────────────
          // A done message carrying `id` updates an EXISTING bubble in place
          // (or appends a new one) — used by the live delegation card so the
          // chat keeps showing the run's progress instead of freezing at
          // "started". Never a turn-lifecycle event: no spinner changes, no
          // merge with the last assistant message.
          if (msg.id) {
            // Id'd bubbles stream IN PLACE: done:false chunks append to the
            // existing bubble (isolated from the active turn's live buffer —
            // e.g. an auto-review streaming while the user chats), and a
            // done:true terminal message replaces it. Never a turn-lifecycle
            // event: no spinner changes, no merge with the live turn.
            setMessages(prev => {
              const idx = prev.findIndex(m => m.id === msg.id);
              if (idx < 0) {
                return [...prev, { role: 'assistant', content: msg.content, id: msg.id }];
              }
              const copy = [...prev];
              const cur = copy[idx]!;
              copy[idx] = msg.replace
                ? { role: 'assistant', content: msg.content, id: msg.id }
                : { role: 'assistant', content: cur.content + msg.content, id: msg.id };
              return copy;
            });
            break;
          }

          if (msg.done) {
            setLoading(false);
            // A reply arriving means the agentic turn finished — no consent
            // prompt can still be pending.
            setConsent(null);
            // Snapshot nothing here: the finished message is built from the
            // live trace below (before finishTurnState wipes it). Hidden tool
            // calls (chat.showToolCalls=false) are excluded — never recorded
            // into the message.
            const segs: TraceEntry[] = traceRef.current
              .filter(seg => seg.kind === 'thinking' || seg.call.showDetails !== false)
              .map(seg =>
                seg.kind === 'thinking'
                  ? { kind: 'thinking' as const, text: capRecord(seg.text, 12000) || '' }
                  : {
                      kind: 'tool' as const,
                      call: {
                        id: seg.call.id,
                        name: seg.call.name,
                        arguments: seg.call.arguments,
                        result: capRecord(seg.call.result, 8000),
                        showDetails: seg.call.showDetails,
                        done: seg.call.done,
                      },
                    }
              );
            const text = ((streamTextRef.current || '') + (msg.content || '')).trim();
            if (!text && segs.length === 0) {
              finishTurnState();
              break; // nothing to show — never ends the chat abruptly
            }
            const finalMsg: any = {
              role: 'assistant',
              content: text,
              ...(segs.length > 0 ? { trace: segs } : {}),
            };
            setMessages(prev => [...prev, finalMsg]);
            // 0.6.7: hand the turn's record back so the host can persist it —
            // only this side knows how reasoning and tool cards interleave.
            // `text` keys it to the answer it produced.
            if (segs.length > 0 && text) {
              vscode.postMessage({ type: 'recordTurnTrace', content: text, entries: segs });
            }
            finishTurnState();
          } else {
            setLoading(true);
            // Buffer the streamed answer text; the live bubble renders it and
            // it lands as a normal message on completion.
            //
            // Text flagged `isThinking` is an agentic iteration's PRE-TOOL
            // reasoning. The host mirrors it as an assistant message only so
            // this refusal keeps it out of the answer — it is displayed by its
            // own thinking block, and buffering it here would prepend the
            // iteration's reasoning to the final answer.
            if (msg.content && !msg.isThinking) {
              streamTextRef.current += msg.content;
              setStreamText(streamTextRef.current);
            }
          }
          break;

        case 'thinkingMessage':
          // AI thinking/reasoning text. `newBlock` marks a complete pre-tool
          // reasoning step from the agentic loop → it becomes its OWN trace
          // entry, so each thinking block stays between the tool batches it
          // introduced. Plain streamed deltas (no newBlock) may split
          // mid-word — they coalesce into the current block with no glue.
          if (msg.content) {
            const next = [...traceRef.current];
            // Reasoning that continues a block only while the ANSWER has not
            // started streaming: once answer text exists, a delta without
            // `newBlock` is a separate reasoning block, never an append to the
            // block that preceded the answer (which used to leave the answer's
            // opening tokens inside the Thinking block).
            const last = next[next.length - 1];
            const continuesLast = !!last && last.kind === 'thinking' && !streamTextRef.current;
            if (msg.newBlock || !continuesLast) {
              next.push({ key: `th-${++thinkingSeqRef.current}`, kind: 'thinking', text: msg.content });
            } else if (last && last.kind === 'thinking') {
              last.text += msg.content;
            }
            commitLiveTrace(next);
          }
          break;

        case 'toolCall':
          // Agentic loop is about to run a tool — insert its card in flow,
          // directly after whatever thinking block preceded it.
          if (!traceRef.current.some(t => t.kind === 'tool' && t.key === msg.call.id)) {
            commitLiveTrace([
              ...traceRef.current,
              {
                key: msg.call.id,
                kind: 'tool',
                call: {
                  id: msg.call.id,
                  name: msg.call.name,
                  arguments: msg.call.arguments || {},
                  showDetails: msg.call.showDetails !== false,
                },
              },
            ]);
          }
          break;

        case 'toolResult':
          // Tool finished — mark its card completed with the result.
          commitLiveTrace(
            traceRef.current.map(t =>
              t.kind === 'tool' && t.key === msg.callId
                ? { ...t, call: { ...t.call, result: msg.content, done: true } }
                : t
            )
          );
          break;

        case 'toolCallDone':
          // Hidden tool calls (chat.showToolCalls=false) never carry result
          // content — the host posts this bare tick so the "Working…"
          // disclosure can flip the row from running to completed.
          commitLiveTrace(
            traceRef.current.map(t =>
              t.kind === 'tool' && t.key === msg.callId
                ? { ...t, call: { ...t.call, done: true } }
                : t
            )
          );
          break;

        case 'loading':
          setLoading(msg.loading);
          break;

        case 'delegationSuggestion':
          setDelegationSuggestions(msg.suggestions);
          break;

        case 'error': {
          setError(msg.message);
          setLoading(false);
          // A failed project/model fetch must not leave the wizard stuck on
          // "Fetching…" forever (Refresh links are gated on !loading).
          setProjectsLoading(false);
          setModelsLoading(false);
          // An error ends the turn — no consent prompt can still be pending.
          setConsent(null);
          // Flush any partially streamed answer into the thread (it was
          // already visible in the live bubble) before resetting turn state —
          // never silently drop text the user watched arrive.
          const partialText = streamTextRef.current;
          finishTurnState();
          if (partialText && partialText.trim()) {
            setMessages(prev => [...prev, { role: 'assistant', content: partialText }]);
          }
          break;
        }

        case 'consentRequest':
          // Agent requires consent for a mutating tool (inline mode).
          setConsent({
            requestId: msg.requestId,
            tool: msg.tool,
            args: msg.args,
            autoApproveMs: msg.autoApproveMs,
            // Host-enforced deadline — the card counts down to it, and the
            // host resolves the prompt when it passes (even if this card is
            // hidden behind the full-page wizard/config at that moment).
            expiresAt: msg.expiresAt,
          });
          break;

        case 'confirmationRequest': {
          // Generic in-chat confirmation card (replaces native dialogs).
          const curKey = activeSessionIdRef.current || 'default';
          const req: ConfirmationRequest = {
            requestId: msg.requestId,
            title: msg.title,
            description: msg.description,
            options: msg.options,
            expiresAt: msg.expiresAt,
          };
          setConfirmationsBySession(prev => {
            const next = { ...prev, [curKey]: req };
            confirmationsBySessionRef.current = next;
            return next;
          });
          break;
        }

        case 'promptExpired':
          // A consent/confirmation request timed out and the host already
          // resolved it (auto-approve / auto-deny / auto-cancel) — drop the
          // card so it can't linger as a zombie. No response is sent: the
          // host owns the outcome, and a fabricated option value could hit
          // the wrong branch of the waiting flow.
          if (msg.action === 'approve' || msg.action === 'deny') {
            setConsent(prev => (prev?.requestId === msg.requestId ? null : prev));
          }
          if (msg.action === 'cancel') {
            setConfirmationsBySession(prev => {
              let changed = false;
              const next = { ...prev };
              for (const [k, v] of Object.entries(next)) {
                if (v?.requestId === msg.requestId) {
                  delete next[k];
                  changed = true;
                }
              }
              if (changed) {
                confirmationsBySessionRef.current = next;
                return next;
              }
              return prev;
            });
          }
          break;

        case 'choicePrompt': {
          // AI detected a choice prompt — show as inline confirmation card.
          // isChoice marks it: clicking an option sends the choice as a user
          // message (the LLM then acts on it as a follow-up turn).
          const curKey = activeSessionIdRef.current || 'default';
          const req: ConfirmationRequest = {
            requestId: msg.requestId,
            title: 'Choose an option',
            description: msg.question,
            options: msg.options,
            isChoice: true,
          };
          setConfirmationsBySession(prev => {
            const next = { ...prev, [curKey]: req };
            confirmationsBySessionRef.current = next;
            return next;
          });
          break;
        }

        case 'config': {
          const cfg = msg.config as unknown as SanitizedConfig;
          // Persisted default for what happens when you send while busy.
          if (cfg.chatInputWhileBusy) setInputWhileBusy(cfg.chatInputWhileBusy);
          setConfig(cfg);
          // Sync the Chat|Plan|Act toggle with the persisted setting (the
          // webview reloads fresh, but the host kept the stored mode).
          if (cfg.mode) setMode(cfg.mode);
          // Project switcher: fetch the org project list once the wizard is
          // fully configured (no creds in the message → host uses saved
          // settings). ADO may be skipped — never auto-fetch projects when it
          // isn't configured (the host would only error out).
          if (cfg.configured && (cfg.adoConnectionConfigured ?? cfg.adoConfigured) === true && !projectsRequestedRef.current) {
            projectsRequestedRef.current = true;
            setProjectsLoading(true);
            vscode.postMessage({ type: 'fetchProjects' });
          }
          break;
        }

        case 'modeChanged':
          setMode(msg.mode);
          break;

        case 'agentList':
          setAgents(msg.agents.map(a => ({
            name: a.name,
            displayName: a.displayName,
            installed: a.installed,
          })));

          break;

        case 'agentRunsList': {
          // Hydrate multi-run map from extension host (on mount / re-focus)
          const next = new Map<string, { run: any; output: string }>();
          for (const run of msg.runs) {
            next.set(run.id, { run, output: '' });
          }
          setAgentRuns(next);
          break;
        }

        case 'historyRestored':
          // 0.6.7: keep the persisted Thinking/Tools record with each message so
          // a reopened session renders the work that produced an answer (tool
          // cards intact, reasoning collapsed) instead of only the answer text.
          setMessages(restoredMessages(msg.messages));
          setConsent(null);
          finishTurnState();
          break;

        case 'sessionList':
          setSessions(msg.sessions);
          setSessionRun(msg.running ?? null);
          setActiveSessionId(msg.activeId);
          activeSessionIdRef.current = msg.activeId;
          if (msg.activeId) {
            const active = msg.sessions.find(s => s.id === msg.activeId);
            if (active && Array.isArray(active.messages) && active.messages.length > 0) {
              setMessages(prev => (prev.length === 0 ? restoredMessages(active.messages) : prev));
            }
          }
          break;
        case 'sessionSwitched':
          setMessages(restoredMessages(msg.session.messages));
          setActiveSessionId(msg.session.id);
          activeSessionIdRef.current = msg.session.id;
          setConsent(null);
          finishTurnState();
          break;

        case 'sessionRunState':
          setSessionRun(msg.running ?? null);
          break;

        case 'workItemDetail':
          setDetail(msg.item as unknown as WorkItemDetail);

          break;

        case 'taskReplies':
          if (detail && detail.id === msg.workItemId) {
            setDetail(prev => prev ? { ...prev, comments: msg.comments } : prev);
          }
          break;

        case 'agentStatus': {
          // Upsert into the multi-run map
          const runId = msg.run.id;
          setAgentRuns(prev => {
            const next = new Map(prev);
            const existing = next.get(runId);
            next.set(runId, {
              run: msg.run,
              output: (existing?.output ?? '') + (msg.delta ?? ''),
            });
            return next;
          });
          break;
        }

        case 'agentResult': {
          const resultId = msg.run.id;
          setAgentRuns(prev => {
            const next = new Map(prev);
            const existing = next.get(resultId);
            next.set(resultId, {
              run: msg.run,
              // Summary is now shown in the editor panel, not inline
              output: existing?.output ?? '',
            });
            return next;
          });
          // Completion line for the chat thread — SKIPPED when an in-thread
          // run card (id `run:<id>`) exists for this run: the card already
          // carries the live outcome (running → succeeded/failed).
          const statusEmoji = msg.run.status === 'succeeded' ? '✅' : msg.run.status === 'failed' ? '❌' : '⚠️';
          const completionMsg = `${statusEmoji} **Agent ${msg.run.agent}** ${msg.run.status} for #${msg.run.workItemId ?? '?'}`;
          setMessages(prev =>
            prev.some(m => m.id === `run:${resultId}`)
              ? prev
              : [...prev, { role: 'assistant', content: completionMsg }]
          );
          setLoading(false);
          break;
        }

        case 'projectList':
          setProjects(msg.projects);
          setProjectsLoading(false);
          break;

        case 'modelList':
          setModels(msg.models);
          setModelsLoading(false);
          break;

        case 'editorContext':
          // "Add context (@)" — host returns the active editor file +
          // selection; append it to the draft.
          if (msg.text) {
            setDraft(prev => (prev ? prev + '\n\n' : '') + msg.text);
          }
          break;

        case 'attachedFiles':
          // "Attach files" — host returns picked file contents; add them
          // to the file-attachment indicator (not the draft).
          if (msg.files.length > 0) {
            setAttachedFiles(prev => [...prev, ...msg.files]);
          }
          break;

        case 'openProjectWizard':
          setShowProjectWizard(true);
          break;

        case 'projectWizardCreated':
          if (msg.success) {
            setProjectWizardError(null);
            setShowProjectWizard(false);
          } else {
            setProjectWizardError(msg.error || 'Failed to create project');
          }
          break;
        case 'openSkillCatalog':
          setShowSkillCatalog(true);
          break;

        case 'insertText':
          // Right-click context menu: insert text into the chat draft
          if (msg.text) {
            setDraft(prev => (prev ? prev + '\n\n' : '') + msg.text);
          }
          break;

        case 'chatMovedToEditor':
          setChatMovedToEditor(msg.inEditor);
          break;
      }
    };

    window.addEventListener('message', handler);

    // Restore state
    const saved = vscode.getState();
    if (saved?.history && Array.isArray(saved.history) && saved.history.length > 0) {
      setMessages(saved.history);
    }
    if (saved?.detail) {
      setDetail(saved.detail);
    }
    // Restore wizard/catalog visibility states
    if (saved?.showProjectWizard) {
      setShowProjectWizard(true);
    }
    if (saved?.showSkillCatalog) {
      setShowSkillCatalog(true);
    }
    // Restore attached files from context menu
    if (saved?.attachedFiles && Array.isArray(saved.attachedFiles) && saved.attachedFiles.length > 0) {
      setAttachedFiles(saved.attachedFiles);
    }
    if (saved?.confirmationsBySession) {
      setConfirmationsBySession(saved.confirmationsBySession);
      confirmationsBySessionRef.current = saved.confirmationsBySession;
    }
    if (saved?.activeSessionId) {
      setActiveSessionId(saved.activeSessionId);
      activeSessionIdRef.current = saved.activeSessionId;
    }

    vscode.postMessage({ type: 'getConfig' });
    vscode.postMessage({ type: 'listAgents' });
    vscode.postMessage({ type: 'listAgentRuns' });
    vscode.postMessage({ type: 'listSessions' });

    return () => window.removeEventListener('message', handler);
  }, []);

  // Persist history + task detail so the chat restores after panel collapse/reopen
  useEffect(() => {
    vscode.setState({
      history: messages,
      detail,
      showProjectWizard,
      showSkillCatalog,
      attachedFiles,
      confirmationsBySession,
      activeSessionId,
    });
  }, [messages, detail, showProjectWizard, showSkillCatalog, attachedFiles, confirmationsBySession, activeSessionId]);

  // Wizard focus: while a full-page wizard is open (first-run setup,
  // Configuration page, project creation) ask the host to collapse the
  // sibling sidebar views so this webview gets the whole container height.
  const wizardOpen = Boolean(config && !config.configured) || showConfig || showProjectWizard;
  useEffect(() => {
    vscode.postMessage({ type: 'maximizeWizard', active: wizardOpen });
  }, [wizardOpen]);

  // ── Actions ────────────────────────────────────────────────────
  // Post a fully-built message to the host and flip into the working state.
  const sendNow = useCallback((fullContent: string, displayContent: string, images?: ImageAttachment[]) => {
    setMessages(prev => [...prev, { role: 'user', content: displayContent }]);
    vscode.postMessage({ type: 'userMessage', content: fullContent, images });
    setDraft('');
    setAttachedFiles([]);
    setLoading(true); // Show loading indicator immediately
    // A new turn aborts any in-flight run — the host denies the pending
    // prompt; drop the card here too, and reset all turn-live state.
    setConsent(null);
    setConfirmationsBySession(prev => {
      const curKey = activeSessionIdRef.current || 'default';
      const next = { ...prev, [curKey]: null };
      confirmationsBySessionRef.current = next;
      return next;
    });
    finishTurnState();
    // Activity indicator for specific commands
    if (fullContent.trim().toLowerCase().startsWith('/generate-tasks')) {
      setActiveActivity('Generating tasks');
    }
  }, [finishTurnState]);

  // Steer mode: post the text to the host so it is injected into the ACTIVE
  // run's next iteration. The bubble is rendered immediately ("⚡ steering")
  // but the run keeps going — no abort.
  const steerNow = useCallback((fullContent: string, displayContent: string, images?: ImageAttachment[]) => {
    setMessages(prev => [...prev, { role: 'user', content: displayContent, steering: true }]);
    vscode.postMessage({ type: 'steerMessage', content: fullContent, images });
    setDraft('');
    setAttachedFiles([]);
    // Deliberately keep loading=true — the current turn is still running.
  }, []);

  const handleSend = useCallback((content: string, images?: ImageAttachment[]) => {
    // Prepend attached file contents to the message so the LLM sees them
    const fileBlocks = attachedFiles.map(f => `[File: ${f.name}]\n${f.content}\n[/file]`);
    const fullContent = fileBlocks.length > 0
      ? (content ? fileBlocks.join('\n\n') + '\n\n' + content : fileBlocks.join('\n\n'))
      : content;
    // The user bubble shows compact attachment markers, not the file bodies —
    // the bodies already ride along in `fullContent` for the model (declutter
    // item 3); MessageList folds the markers into chips.
    const attachmentMarkers = attachedFiles.map(f => `[Attached: ${f.name}]`).join(' ');
    const imageMarkers = images?.length ? images.map(i => `[Image: ${i.name}]`).join(' ') : '';
    const displayContent = [content, attachmentMarkers, imageMarkers].filter(Boolean).join('\n\n');
    // While the AI is still working, honor the queue/steer default:
    //  - queue → hold the message (shown as a pending chip) and run it next
    //  - steer → post it to the host, which injects it into the RUNNING turn's
    //            next iteration (it does NOT abort the run)
    if (loading && inputWhileBusy === 'queue') {
      if (!fullContent.trim() && !(images && images.length)) return;
      setQueued(prev => [...prev, { id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, fullContent, displayContent, images }]);
      setDraft('');
      setAttachedFiles([]);
      return;
    }
    if (loading && inputWhileBusy === 'steer') {
      if (!fullContent.trim() && !(images && images.length)) return;
      steerNow(fullContent, displayContent, images);
      return;
    }
    sendNow(fullContent, displayContent, images);
  }, [attachedFiles, loading, inputWhileBusy, sendNow, steerNow]);

  // Drain the queue: once the current turn finishes, send the next held message.
  useEffect(() => {
    if (loading || queued.length === 0) return;
    const [next, ...rest] = queued;
    setQueued(rest);
    sendNow(next.fullContent, next.displayContent, next.images);
  }, [loading, queued, sendNow]);

  const handleConsentResponse = useCallback((requestId: string, approved: boolean, scope?: 'once' | 'session' | 'permanent') => {
    setConsent(null);
    vscode.postMessage({ type: 'consentResponse', requestId, approved, scope });
  }, []);

  const handleConfirmationResponse = useCallback((requestId: string, value: string) => {
    // AI choice prompts: the option click becomes the user's follow-up
    // message (same flow as typing it) so the LLM executes the choice.
    // The host never registered a confirmBroker request for choice cards,
    // so a confirmationResponse there would be a no-op.
    const curKey = activeSessionIdRef.current || 'default';
    const curConf = confirmationsBySessionRef.current[curKey];
    const wasChoice = curConf?.isChoice === true;
    setConfirmationsBySession(prev => {
      const next = { ...prev, [curKey]: null };
      confirmationsBySessionRef.current = next;
      return next;
    });
    if (wasChoice) {
      setMessages(prev => [...prev, { role: 'user', content: value }]);
      setLoading(true);
      vscode.postMessage({ type: 'sendMessage', content: value });
      return;
    }
    vscode.postMessage({ type: 'confirmationResponse', requestId, value });
  }, []);

  const handleConfirmationDismiss = useCallback((requestId: string) => {
    const curKey = activeSessionIdRef.current || 'default';
    const curConf = confirmationsBySessionRef.current[curKey];
    const wasChoice = curConf?.isChoice === true;
    setConfirmationsBySession(prev => {
      const next = { ...prev, [curKey]: null };
      confirmationsBySessionRef.current = next;
      return next;
    });
    if (!wasChoice) {
      vscode.postMessage({ type: 'confirmationResponse', requestId, value: '' });
    }
  }, []);

  const handleConfirmationToggleMinimize = useCallback((requestId: string, isMin: boolean) => {
    const curKey = activeSessionIdRef.current || 'default';
    setConfirmationsBySession(prev => {
      const cur = prev[curKey];
      if (!cur || cur.requestId !== requestId) return prev;
      const next = { ...prev, [curKey]: { ...cur, minimized: isMin } };
      confirmationsBySessionRef.current = next;
      return next;
    });
  }, []);

  const handleClear = useCallback(() => {
    vscode.postMessage({ type: 'clearConversation' });
    setMessages([]);
    // Clear must fully reset the input: a stuck spinner (hung LLM stream)
    // would otherwise leave the send button dead after clearing.
    setLoading(false);
    setConsent(null);
    setConfirmationsBySession(prev => {
      const curKey = activeSessionIdRef.current || 'default';
      const next = { ...prev, [curKey]: null };
      confirmationsBySessionRef.current = next;
      return next;
    });
    setDraft('');
  }, []);

  const handleSaveConfig = useCallback((form: {
    adoOrganization: string;
    adoProject: string;
    adoPat: string;
    llmProvider: string;
    llmApiUrl: string;
    llmApiKey: string;
    llmModel: string;
  }) => {
    vscode.postMessage({ type: 'updateConfig', config: form });
  }, []);

  const handleModeSelect = useCallback((selectedMode: 'inline' | 'plan' | 'act' | 'yolo') => {
    vscode.postMessage({ type: 'selectMode', mode: selectedMode });
  }, []);

  const handleClarify = useCallback((workItemId: number, question: string) => {
    vscode.postMessage({ type: 'requestClarification', workItemId, question, mentionCreator: true });
  }, []);

  const handleCheckReplies = useCallback((workItemId: number) => {
    vscode.postMessage({ type: 'checkTaskReplies', workItemId });
  }, []);

  const handleCloseDetail = useCallback(() => {
    setDetail(null);
  }, []);



  // Session history callbacks
  const handleSwitchSession = useCallback((sessionId: string) => {
    setActiveSessionId(sessionId);
    activeSessionIdRef.current = sessionId;
    vscode.postMessage({ type: 'switchSession', sessionId });
  }, []);

  const handleNewSession = useCallback(() => {
    vscode.postMessage({ type: 'newSession' });
    setMessages([]);
    setLoading(false);
    setDraft('');
  }, []);

  const handleRenameSession = useCallback((sessionId: string, name: string) => {
    vscode.postMessage({ type: 'renameSession', sessionId, name });
  }, []);

  const handleDeleteSession = useCallback((sessionId: string) => {
    vscode.postMessage({ type: 'deleteSession', sessionId });
    setConfirmationsBySession(prev => {
      const next = { ...prev };
      delete next[sessionId];
      confirmationsBySessionRef.current = next;
      return next;
    });
  }, []);

  const handleDeleteAllSessions = useCallback(() => {
    vscode.postMessage({ type: 'clearAllSessions' });
    setMessages([]);
    setActiveSessionId(null);
    activeSessionIdRef.current = null;
    setConfirmationsBySession({});
    confirmationsBySessionRef.current = {};
  }, []);

  // Item 6: collapse/expand-all override fed to MessageList. `null` = no
  // override (each turn keeps its default); `true`/`false` forces every row.
  const [activityOverride, setActivityOverride] = useState<boolean | null>(null);

  // Item 5: chat density. The host owns the persisted setting; the webview
  // mirrors it (via the 'config' message) and asks for the next mode when the
  // kebab “Chat density” action fires.
  const density = normalizeDensity(config?.chatDensity);

  // ── Kebab menu actions ───────────────────────────────────────
  const handleKebabAction = useCallback((action: string) => {
    switch (action) {
      case 'toggleAllTurns':
        setActivityOverride(prev => (prev === false ? true : false));
        break;
      case 'refreshWorkItems':
        vscode.postMessage({ type: 'fetchWorkItems' });
        break;
      case 'rerunWizard':
        vscode.postMessage({ type: 'rerunWizard' });
        break;
      case 'openSettings':
        setShowConfig(true);
        break;
      case 'moveChatToEditor':
        vscode.postMessage({ type: 'moveChatToEditor' });
        break;
      case 'moveChatToSidebar':
        vscode.postMessage({ type: 'moveChatToSidebar' });
        break;
      case 'cycleChatDensity': {
        const next = cycleDensity(density);
        setConfig((prev) => (prev ? { ...prev, chatDensity: next } : prev));
        vscode.postMessage({ type: 'updateConfig', config: { chatDensity: next } });
        break;
      }
      case 'clearAllSessions':
        handleDeleteAllSessions();
        break;
    }
  }, [handleDeleteAllSessions, density]);

  const handleFetchProjects = useCallback((organization?: string, pat?: string) => {
    setProjectsLoading(true);
    // Pass the typed-but-unsaved credentials: the host fetches with these
    // directly (saved settings are empty until "Save & Continue").
    vscode.postMessage({ type: 'fetchProjects', organization, pat });
  }, []);

  const handleFetchModels = useCallback((provider?: string, apiUrl?: string, apiKey?: string) => {
    // Drop any list from a previous endpoint so the picker can't show stale
    // models while the new list loads.
    setModels([]);
    setModelsLoading(true);
    // Same typed-but-unsaved pattern as projects: the host builds a temp
    // LlmClient from these (falling back to saved settings when absent).
    vscode.postMessage({ type: 'fetchModels', provider, apiUrl, apiKey });
  }, []);

  const handleSwitchProject = useCallback((projectName: string) => {
    // Host persists the choice (settings + workspaceState) and refreshes work
    // items (chat list + sidebar tree) for the new project.
    vscode.postMessage({ type: 'selectProject', projectName });
  }, []);

  // ── Render ─────────────────────────────────────────────────────

  // Welcome screen when not configured
  if (config && !config.configured) {
    return (
      <div className="app">
        <WelcomeScreen
          config={config}
          onSave={handleSaveConfig}
          onFetchProjects={handleFetchProjects}
          projects={projects}
          projectsLoading={projectsLoading}
          onFetchModels={handleFetchModels}
          models={models}
          modelsLoading={modelsLoading}
        />
      </div>
    );
  }

  // Loading state before config arrives
  if (!config) {
    return (
      <div className="app">
        <div className="empty-state">
          <div className="loading-dots">
            <span /><span /><span />
          </div>
        </div>
      </div>
    );
  }

  // Configuration page
  if (showConfig) {
    return (
      <div className="app">
        <ConfigurationPage
          onBack={() => {
            setShowConfig(false);
            // Closing Configuration re-arms the ADO reminder (still skipped).
            setAdoReminderDismissed(false);
          }}
          onFetchModels={handleFetchModels}
          models={models}
          modelsLoading={modelsLoading}
        />
      </div>
    );
  }
  // Skill catalog
  if (showSkillCatalog) {
    return (
      <div className="app">
        <SkillCatalog
          onClose={() => setShowSkillCatalog(false)}
          onExecute={(_skillId, skillName) => {
            setActiveActivity(`Executing skill: ${skillName}`);
            setLoading(true);
          }}
        />
      </div>
    );
  }

  if (chatMovedToEditor && !config?.isEditor) {
    return (
      <div className="app chat-layout">
        <div className="chat-moved-placeholder">
          <div className="chat-moved-icon">↗️</div>
          <h2>Chat is open in the Editor Area</h2>
          <p>The conversation is currently active in an editor tab.</p>
          <button
            className="btn btn-primary chat-moved-btn"
            onClick={() => vscode.postMessage({ type: 'moveChatToSidebar' })}
            type="button"
          >
            ↙️ Return Chat to Side Bar
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="app chat-layout">
      {/* Task detail panel (collapsible) */}
      {detail && (
        <TaskDetailPanel
          detail={detail}
          onClarify={handleClarify}
          onCheckReplies={handleCheckReplies}
          onClose={handleCloseDetail}
        />
      )}

      {/* ADO-not-configured reminder — ADO may be skipped in the setup wizard,
          so keep nudging until it's set up (banner reappears on reload / after
          closing Configuration if still skipped; dismissed only for this page
          session via the ✕ button). */}
      {config.configured && !(config.adoConnectionConfigured ?? config.adoConfigured) && !adoReminderDismissed && (
        <div className="ado-not-configured-banner">
          <span className="ado-not-configured-text">
            <strong>Azure DevOps isn't configured</strong> — work items, ADO task tracking, branches, and pull requests are disabled.
          </span>
          <button
            className="btn btn-secondary"
            onClick={() => setShowConfig(true)}
            type="button"
          >
            Configure…
          </button>
          <button
            className="ado-not-configured-dismiss"
            onClick={() => setAdoReminderDismissed(true)}
            title="Dismiss (reminder returns after reload)"
            type="button"
          >
            ✕
          </button>
        </div>
      )}

      {/* Error banner */}
      <ErrorBanner message={error} onDismiss={() => setError(null)} />

      {/* Chat header with session history, project switcher + kebab menu */}
      <div className="chat-header">
        <span className="chat-header-title">ADO Code</span>
        <SessionHistory
          sessions={sessions}
          activeId={activeSessionId}
          running={sessionRun}
          onSwitch={handleSwitchSession}
          onNew={handleNewSession}
          onRename={handleRenameSession}
          onDelete={handleDeleteSession}
          onDeleteAll={handleDeleteAllSessions}
        />
        <ProjectSwitcher
          projects={projects}
          current={config.adoProject}
          loading={projectsLoading}
          onSwitch={handleSwitchProject}
          onRefresh={handleFetchProjects}
        />
        <KebabMenu
          items={[
            {
              label: config?.isEditor ? 'Return Chat to Side Bar' : 'Move chat into Editor Area',
              icon: config?.isEditor ? '↙️' : '↗️',
              action: config?.isEditor ? 'moveChatToSidebar' : 'moveChatToEditor',
            },
            { label: 'Refresh Work Items', icon: '↻', action: 'refreshWorkItems' },
            { label: 'Rerun Setup Wizard', icon: '🔄', action: 'rerunWizard' },
            { label: 'Configuration…', icon: '⚙', action: 'openSettings' },
            { label: `Chat density: ${densityLabel(density)}`, icon: '📐', action: 'cycleChatDensity' },
            { label: '', action: '', separator: true },
            { label: collapseAllActionLabel(activityOverride), icon: '≡', action: 'toggleAllTurns' },
              { label: 'Clear Chat History', icon: '🗑️', action: 'clearAllSessions' },
          ]}
          onSelect={handleKebabAction}
        />
      </div>

      {/* Agent output panels (one per running/recent agent) */}
      {Array.from(agentRuns.entries()).map(([id, { run, output }]) => (
        <AgentOutputPanel
          key={id}
          run={run}
          output={output}
          loading={loading && run.status === 'running'}
          onDismiss={(runId) => {
            setAgentRuns(prev => {
              const next = new Map(prev);
              next.delete(runId);
              return next;
            });
            // Persist the dismissal host-side so it survives re-hydration
            // (panel remount / reload) instead of reappearing.
            vscode.postMessage({ type: 'dismissAgentRun', runId });
          }}
          onOpenInEditor={(runId) => {
            // Open the run's LIVE progress panel in the editor area — works
            // for running runs (streaming view) and finished runs (summary).
            vscode.postMessage({ type: 'openAgentProgress', runId });
          }}
        />
      ))}

      {/* Messages */}
      <MessageList
        messages={messages}
        loading={loading}
        liveTrace={liveTrace}
        streamText={streamText}
        activity={activeActivity}
          activityOverride={activityOverride}
            density={density}
      />

      {/* Consent card — agent wants to run a mutating tool (inline mode) */}
      {consent && (
        <ConsentCard request={consent} onRespond={handleConsentResponse} />
      )}

      {/* Confirmation card — in-chat replacement for native VS Code dialogs */}
      {confirmation && (
        <ConfirmationCard
          request={confirmation}
          onRespond={handleConfirmationResponse}
          onDismiss={handleConfirmationDismiss}
          onToggleMinimize={handleConfirmationToggleMinimize}
          onExpired={(requestId) => {
            // Timeout auto-cancel: the host already resolved the wait as
            // cancelled — just remove the card (never fabricate a value).
            setConfirmationsBySession(prev => {
              const curKey = activeSessionIdRef.current || 'default';
              if (prev[curKey]?.requestId === requestId) {
                const next = { ...prev, [curKey]: null };
                confirmationsBySessionRef.current = next;
                return next;
              }
              return prev;
            });
          }}
        />
      )}

      {/* Input */}
      {/* Active-model capability gating: no vision → image attach/paste is
          disabled; no tool calling → agentic modes degrade to plain chat,
          surfaced as a persistent warning. */}
      {/* Delegation suggestions proposed by the AI (chat.suggestDelegation) */}
      {delegationSuggestions.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 12px', margin: '4px 12px', borderRadius: 6, background: 'var(--vscode-editorWidget-background, rgba(128,128,128,0.1))', border: '1px solid var(--vscode-widget-border, rgba(128,128,128,0.3))', fontSize: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <strong>Suggested delegation</strong>
            <button type="button" title="Dismiss" onClick={() => setDelegationSuggestions([])} style={{ cursor: 'pointer', border: 'none', background: 'transparent', color: 'inherit', fontSize: 14, lineHeight: 1 }}>×</button>
          </div>
          {delegationSuggestions.map((s, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ opacity: 0.85 }}><code>{s.agent}</code>{s.reason ? ` — ${s.reason}` : ''}</span>
              <button type="button" onClick={() => { vscode.postMessage({ type: 'delegateToAgent', prompt: s.prompt, agent: s.agent }); setDelegationSuggestions([]); }} style={{ cursor: 'pointer', marginLeft: 'auto', padding: '2px 10px', borderRadius: 3, border: 'none', background: 'var(--vscode-button-background)', color: 'var(--vscode-button-foreground)' }}>Delegate</button>
            </div>
          ))}
        </div>
      )}

      {/* Queue/steer control: what happens if you send while the AI is busy */}
      <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, padding: '4px 12px', fontSize: 11, borderTop: '1px solid var(--vscode-panel-border, rgba(128,128,128,0.25))' }}>
        <span style={{ opacity: 0.7 }}>While busy:</span>
        <button
          type="button"
          onClick={() => setInputWhileBusy('steer')}
          title="Interrupt the current response and apply your message now"
          style={{ cursor: 'pointer', padding: '1px 8px', borderRadius: 10, fontSize: 11, border: '1px solid var(--vscode-button-border, transparent)', background: inputWhileBusy === 'steer' ? 'var(--vscode-button-background)' : 'transparent', color: inputWhileBusy === 'steer' ? 'var(--vscode-button-foreground)' : 'var(--vscode-foreground)' }}
        >Steer</button>
        <button
          type="button"
          onClick={() => setInputWhileBusy('queue')}
          title="Hold your message and send it automatically when the AI finishes"
          style={{ cursor: 'pointer', padding: '1px 8px', borderRadius: 10, fontSize: 11, border: '1px solid var(--vscode-button-border, transparent)', background: inputWhileBusy === 'queue' ? 'var(--vscode-button-background)' : 'transparent', color: inputWhileBusy === 'queue' ? 'var(--vscode-button-foreground)' : 'var(--vscode-foreground)' }}
        >Queue</button>
        {queued.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginLeft: 4 }}>
            <span style={{ opacity: 0.7 }}>{queued.length} queued:</span>
            {queued.map((q, i) => (
              <span key={q.id} title={q.displayContent} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, maxWidth: 260, padding: '1px 6px', borderRadius: 10, background: 'var(--vscode-badge-background, rgba(128,128,128,0.2))', color: 'var(--vscode-badge-foreground, inherit)' }}>
                <span style={{ opacity: 0.7 }}>{i + 1}.</span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{q.displayContent.replace(/\s+/g, ' ').slice(0, 60)}</span>
                <button type="button" title="Remove from queue" onClick={() => setQueued(prev => prev.filter(x => x.id !== q.id))} style={{ cursor: 'pointer', border: 'none', background: 'transparent', color: 'inherit', padding: 0, fontSize: 13, lineHeight: 1 }}>×</button>
              </span>
            ))}
          </div>
        )}
      </div>

      <StatusLine
        loading={loading}
        activity={activeActivity}
        streamText={streamText}
        trace={liveTrace}
      />

      <InputBar
        mode={mode}
        value={draft}
        onValueChange={setDraft}
        onSend={handleSend}
        onStop={() => {
          vscode.postMessage({ type: 'stopGeneration' });
          setQueued([]); // stopping the turn cancels anything held in the queue
          setLoading(false);
          setConsent(null);
          setConfirmationsBySession(prev => {
            const curKey = activeSessionIdRef.current || 'default';
            const next = { ...prev, [curKey]: null };
            confirmationsBySessionRef.current = next;
            return next;
          });
        }}
        onClear={handleClear}
        onModeSelect={handleModeSelect}
        onAddContext={() => vscode.postMessage({ type: 'getEditorContext' })}
        onAttachFiles={() => vscode.postMessage({ type: 'pickFiles' })}
        loading={loading ? mode : ''}
        canAttachImages={config.modelCapabilities?.vision ?? true}
        attachedFiles={attachedFiles}
        onRemoveAttachedFile={(index) => setAttachedFiles(prev => prev.filter((_, i) => i !== index))}
      />
      {config.configured && config.modelCapabilities && !config.modelCapabilities.tools && (
        <div className="model-capability-warning" title="Tool calling unavailable for the active model">
          ⚠ <strong>{config.llmModel}</strong> doesn't support tool calling — Chat/Plan/Act run as plain chat (no tools, no file edits, no delegation).
        </div>
      )}
      {/* Project creation wizard */}
      {showProjectWizard && (
        <ProjectCreationWizard
          onClose={() => {
            setProjectWizardError(null);
            setShowProjectWizard(false);
          }}
          error={projectWizardError}
          onClearError={() => setProjectWizardError(null)}
        />
      )}
    </div>
  );
}

export default App;
