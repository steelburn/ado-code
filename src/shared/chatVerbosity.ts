/**
 * Chat verbosity — ONE user-facing scale over the three persisted chat
 * settings (`adoCode.chat.showThinking`, `adoCode.chat.showToolCalls`,
 * `adoCode.chat.density`).
 *
 * WHY a projection and not a fourth setting:
 * The three settings are consumed by different layers — the host decides
 * whether it even posts reasoning text and tool payloads, the webview decides
 * how much chrome to render per turn. A separate "verbosity" setting would be
 * a SECOND source of truth that drifts from them the moment one of the three
 * is edited by hand (settings.json, another window, a rolled-back release).
 * So the level is DERIVED from the three settings, and writing a level writes
 * all three at once: still exactly one place the value lives, but one control
 * the user actually sees — in the Configuration page and in the kebab menu.
 *
 * Levels, narrated-est first. Each step only ever REMOVES:
 *
 *   verbose   thinking on,  tool calls on,  comfortable spacing  (the default)
 *   standard  thinking off, tool calls on,  comfortable spacing
 *   compact   thinking off, tool calls on,  compact spacing
 *   minimal   thinking off, tool calls off, answers-only spacing
 *
 * A combination matching no preset reports `custom` — it is still valid and
 * still rendered (as "Custom"), it just cannot be named by one level.
 */

import { normalizeDensity, type ChatDensity } from './chatDensity';

/** The named levels of the verbosity scale, narriest first. */
export type ChatVerbosityLevel = 'verbose' | 'standard' | 'compact' | 'minimal';

/** What the three underlying settings currently add up to. */
export type ChatVerbositySetting = ChatVerbosityLevel | 'custom';

/** The three persisted values a level expands to. */
export interface ChatVerbosityState {
    showThinking: boolean;
    showToolCalls: boolean;
    density: ChatDensity;
}

/** Canonical, ordered list of levels: cycling walks this array. */
export const CHAT_VERBOSITY_LEVELS: readonly ChatVerbosityLevel[] = [
    'verbose',
    'standard',
    'compact',
    'minimal',
];

/** Level → the exact settings it persists. */
export const CHAT_VERBOSITY_PRESETS: Readonly<Record<ChatVerbosityLevel, ChatVerbosityState>> = {
    verbose: { showThinking: true, showToolCalls: true, density: 'comfortable' },
    standard: { showThinking: false, showToolCalls: true, density: 'comfortable' },
    compact: { showThinking: false, showToolCalls: true, density: 'compact' },
    minimal: { showThinking: false, showToolCalls: false, density: 'answers-only' },
};

/** Level used when nothing is configured (matches the settings' own defaults). */
export const DEFAULT_CHAT_VERBOSITY: ChatVerbosityLevel = 'verbose';

const LABELS: Readonly<Record<ChatVerbositySetting, string>> = {
    verbose: 'Verbose',
    standard: 'Standard',
    compact: 'Compact',
    minimal: 'Minimal',
    custom: 'Custom',
};

function asBoolean(value: unknown, fallback: boolean): boolean {
    return typeof value === 'boolean' ? value : fallback;
}

/** True for a known level (guards untrusted/webview payload values). */
export function isChatVerbosityLevel(value: unknown): value is ChatVerbosityLevel {
    return typeof value === 'string'
        && (CHAT_VERBOSITY_LEVELS as readonly string[]).includes(value);
}

/**
 * Tolerant read of the three raw config values (dotted or camelCase, from
 * settings.json or a webview payload — all may be undefined or garbage).
 * Unset/invalid values fall back to the default preset, so a half-configured
 * user still lands on a named level instead of a phantom "custom".
 */
export function readChatVerbosity(
    showThinking: unknown,
    showToolCalls: unknown,
    density: unknown,
): ChatVerbosityState {
    const base = CHAT_VERBOSITY_PRESETS[DEFAULT_CHAT_VERBOSITY];
    return {
        showThinking: asBoolean(showThinking, base.showThinking),
        showToolCalls: asBoolean(showToolCalls, base.showToolCalls),
        density: normalizeDensity(density),
    };
}

/** The preset a level expands to (a fresh object — callers may write to it). */
export function chatVerbosityPreset(level: ChatVerbosityLevel): ChatVerbosityState {
    const preset = CHAT_VERBOSITY_PRESETS[level] ?? CHAT_VERBOSITY_PRESETS[DEFAULT_CHAT_VERBOSITY];
    return { ...preset };
}

/** The level a state adds up to, or `custom` when it matches no preset. */
export function chatVerbosityLevel(state: ChatVerbosityState): ChatVerbositySetting {
    for (const level of CHAT_VERBOSITY_LEVELS) {
        const preset = CHAT_VERBOSITY_PRESETS[level];
        if (preset.showThinking === state.showThinking
            && preset.showToolCalls === state.showToolCalls
            && preset.density === state.density) {
            return level;
        }
    }
    return 'custom';
}

/** Menu/select label for a level or for `custom`. */
export function chatVerbosityLabel(level: ChatVerbositySetting): string {
    return LABELS[level] ?? LABELS[DEFAULT_CHAT_VERBOSITY];
}

/**
 * The next level when the user cycles the control. `custom` (a hand-tuned
 * combination) has no position on the scale, so cycling starts at the top
 * rather than guessing which neighbour it is closest to.
 */
export function cycleChatVerbosity(current: ChatVerbositySetting): ChatVerbosityLevel {
    const index = CHAT_VERBOSITY_LEVELS.indexOf(current as ChatVerbosityLevel);
    if (index < 0) {
        return CHAT_VERBOSITY_LEVELS[0];
    }
    return CHAT_VERBOSITY_LEVELS[(index + 1) % CHAT_VERBOSITY_LEVELS.length];
}

/** One-line description of what a state renders — used for the Custom option. */
export function chatVerbositySummary(state: ChatVerbosityState): string {
    const parts = [
        state.showThinking ? 'thinking' : 'no thinking',
        state.showToolCalls ? 'tool calls' : 'no tool calls',
        state.density,
    ];
    return parts.join(', ');
}
