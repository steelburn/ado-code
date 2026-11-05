import * as assert from 'assert';
import {
    CHAT_VERBOSITY_LEVELS,
    CHAT_VERBOSITY_PRESETS,
    DEFAULT_CHAT_VERBOSITY,
    chatVerbosityLabel,
    chatVerbosityLevel,
    chatVerbosityPreset,
    chatVerbositySummary,
    cycleChatVerbosity,
    isChatVerbosityLevel,
    readChatVerbosity,
    type ChatVerbositySetting,
} from '../../../shared/chatVerbosity';

suite('shared/chatVerbosity', () => {
    suite('presets', () => {
        test('each level only ever removes chrome as it gets quieter', () => {
            const order = ['verbose', 'standard', 'compact', 'minimal'] as const;
            assert.deepStrictEqual([...CHAT_VERBOSITY_LEVELS], [...order]);
            for (let i = 1; i < order.length; i++) {
                const prev = CHAT_VERBOSITY_PRESETS[order[i - 1]];
                const next = CHAT_VERBOSITY_PRESETS[order[i]];
                // never turns something OFF back on
                assert.strictEqual(next.showThinking && !prev.showThinking, false);
                assert.strictEqual(next.showToolCalls && !prev.showToolCalls, false);
            }
        });

        test('the default level matches the settings defaults (everything on)', () => {
            assert.strictEqual(DEFAULT_CHAT_VERBOSITY, 'verbose');
            assert.deepStrictEqual(chatVerbosityPreset(DEFAULT_CHAT_VERBOSITY), {
                showThinking: true,
                showToolCalls: true,
                density: 'comfortable',
            });
        });

        test('presets are the only levels that keep thinking, tools and density coupled', () => {
            assert.strictEqual(CHAT_VERBOSITY_PRESETS.standard.showThinking, false);
            assert.strictEqual(CHAT_VERBOSITY_PRESETS.standard.showToolCalls, true);
            assert.strictEqual(CHAT_VERBOSITY_PRESETS.compact.density, 'compact');
            assert.strictEqual(CHAT_VERBOSITY_PRESETS.minimal.showToolCalls, false);
            assert.strictEqual(CHAT_VERBOSITY_PRESETS.minimal.density, 'answers-only');
        });

        test('chatVerbosityPreset returns a copy, not the shared preset object', () => {
            const preset = chatVerbosityPreset('compact');
            preset.showThinking = true;
            assert.strictEqual(CHAT_VERBOSITY_PRESETS.compact.showThinking, false);
        });
    });

    suite('readChatVerbosity', () => {
        test('reads the three raw values verbatim', () => {
            assert.deepStrictEqual(readChatVerbosity(false, true, 'compact'), {
                showThinking: false,
                showToolCalls: true,
                density: 'compact',
            });
        });

        test('falls back to the default preset when nothing is configured', () => {
            assert.deepStrictEqual(readChatVerbosity(undefined, undefined, undefined), {
                showThinking: true,
                showToolCalls: true,
                density: 'comfortable',
            });
        });

        test('is tolerant of garbage and normalises the density value', () => {
            assert.deepStrictEqual(readChatVerbosity('yes', 0, '  COMPACT '), {
                showThinking: true,
                showToolCalls: true,
                density: 'compact',
            });
            assert.strictEqual(readChatVerbosity(null, null, 'nonsense').density, 'comfortable');
        });
    });

    suite('chatVerbosityLevel', () => {
        test('names every preset', () => {
            for (const level of CHAT_VERBOSITY_LEVELS) {
                assert.strictEqual(chatVerbosityLevel(chatVerbosityPreset(level)), level);
            }
        });

        test('reports custom for a hand-tuned combination', () => {
            assert.strictEqual(
                chatVerbosityLevel({ showThinking: true, showToolCalls: false, density: 'compact' }),
                'custom',
            );
            assert.strictEqual(
                chatVerbosityLevel({ showThinking: true, showToolCalls: true, density: 'answers-only' }),
                'custom',
            );
        });

        test('round-trips through the config values a settings.json edit produces', () => {
            const state = readChatVerbosity(false, true, 'compact');
            assert.strictEqual(chatVerbosityLevel(state), 'compact');
        });
    });

    suite('cycleChatVerbosity', () => {
        test('walks the scale then wraps to the top', () => {
            assert.strictEqual(cycleChatVerbosity('verbose'), 'standard');
            assert.strictEqual(cycleChatVerbosity('standard'), 'compact');
            assert.strictEqual(cycleChatVerbosity('compact'), 'minimal');
            assert.strictEqual(cycleChatVerbosity('minimal'), 'verbose');
        });

        test('custom restarts at the top of the scale', () => {
            assert.strictEqual(cycleChatVerbosity('custom'), 'verbose');
        });

        test('cycling always terminates back at the starting level', () => {
            let level: ChatVerbositySetting = 'compact';
            for (let i = 0; i < CHAT_VERBOSITY_LEVELS.length; i++) {
                level = cycleChatVerbosity(level);
            }
            assert.strictEqual(level, 'compact');
        });
    });

    suite('labels', () => {
        test('produces a human-readable label per level plus custom', () => {
            assert.strictEqual(chatVerbosityLabel('verbose'), 'Verbose');
            assert.strictEqual(chatVerbosityLabel('standard'), 'Standard');
            assert.strictEqual(chatVerbosityLabel('compact'), 'Compact');
            assert.strictEqual(chatVerbosityLabel('minimal'), 'Minimal');
            assert.strictEqual(chatVerbosityLabel('custom'), 'Custom');
        });

        test('an unknown value degrades to the default label instead of blowing up', () => {
            assert.strictEqual(chatVerbosityLabel('nope' as ChatVerbositySetting), 'Verbose');
        });
    });

    suite('chatVerbositySummary', () => {
        test('spells out what a state renders', () => {
            assert.strictEqual(
                chatVerbositySummary({ showThinking: true, showToolCalls: false, density: 'compact' }),
                'thinking, no tool calls, compact',
            );
        });
    });

    suite('isChatVerbosityLevel', () => {
        test('accepts only known levels', () => {
            assert.strictEqual(isChatVerbosityLevel('compact'), true);
            assert.strictEqual(isChatVerbosityLevel('custom'), false);
            assert.strictEqual(isChatVerbosityLevel(undefined), false);
            assert.strictEqual(isChatVerbosityLevel(3), false);
        });
    });
});
