import * as assert from 'assert';
import {
    CHAT_DENSITY_MODES,
    DEFAULT_CHAT_DENSITY,
    normalizeDensity,
    densityContainerClass,
    densityHidesChrome,
    isChromeVisible,
    cycleDensity,
    densityLabel,
    detailsToggleLabel,
    type ChatDensity,
} from '../../../shared/chatDensity';

suite('shared/chatDensity', () => {
    suite('normalizeDensity', () => {
        test('passes through every known mode verbatim', () => {
            assert.strictEqual(normalizeDensity('comfortable'), 'comfortable');
            assert.strictEqual(normalizeDensity('compact'), 'compact');
            assert.strictEqual(normalizeDensity('answers-only'), 'answers-only');
        });

        test('is tolerant of surrounding whitespace and casing', () => {
            assert.strictEqual(normalizeDensity('  Compact '), 'compact');
            assert.strictEqual(normalizeDensity('ANSWERS-ONLY'), 'answers-only');
            assert.strictEqual(normalizeDensity('Answers-Only'), 'answers-only');
        });

        test('falls back to the default for unknown / missing values', () => {
            assert.strictEqual(normalizeDensity('weird'), DEFAULT_CHAT_DENSITY);
            assert.strictEqual(normalizeDensity(undefined), DEFAULT_CHAT_DENSITY);
            assert.strictEqual(normalizeDensity(null), DEFAULT_CHAT_DENSITY);
            assert.strictEqual(normalizeDensity(''), DEFAULT_CHAT_DENSITY);
            assert.strictEqual(normalizeDensity(42), DEFAULT_CHAT_DENSITY);
        });

        test('default mode is comfortable', () => {
            assert.strictEqual(DEFAULT_CHAT_DENSITY, 'comfortable');
        });
    });

    suite('CHAT_DENSITY_MODES', () => {
        test('lists the three modes in ascending order of compression', () => {
            assert.deepStrictEqual(
                [...CHAT_DENSITY_MODES],
                ['comfortable', 'compact', 'answers-only'],
            );
        });
    });

    suite('densityContainerClass', () => {
        test('maps each mode to a stable, prefixed CSS class', () => {
            assert.strictEqual(densityContainerClass('comfortable'), 'chat-density-comfortable');
            assert.strictEqual(densityContainerClass('compact'), 'chat-density-compact');
            assert.strictEqual(densityContainerClass('answers-only'), 'chat-density-answers-only');
        });
    });

    suite('densityHidesChrome', () => {
        test('only answers-only hides tool chrome / reasoning / summary', () => {
            assert.strictEqual(densityHidesChrome('comfortable'), false);
            assert.strictEqual(densityHidesChrome('compact'), false);
            assert.strictEqual(densityHidesChrome('answers-only'), true);
        });
    });

    suite('isChromeVisible', () => {
        test('comfortable and compact always show chrome', () => {
            assert.strictEqual(isChromeVisible('comfortable', false), true);
            assert.strictEqual(isChromeVisible('compact', false), true);
        });

        test('answers-only hides chrome until the turn is expanded', () => {
            assert.strictEqual(isChromeVisible('answers-only', false), false);
            assert.strictEqual(isChromeVisible('answers-only', true), true);
        });
    });

    suite('cycleDensity', () => {
        test('advances comfortable -> compact -> answers-only -> comfortable', () => {
            assert.strictEqual(cycleDensity('comfortable'), 'compact');
            assert.strictEqual(cycleDensity('compact'), 'answers-only');
            assert.strictEqual(cycleDensity('answers-only'), 'comfortable');
        });
    });

    suite('densityLabel', () => {
        test('produces a human-readable label per mode', () => {
            assert.strictEqual(densityLabel('comfortable'), 'Comfortable');
            assert.strictEqual(densityLabel('compact'), 'Compact');
            assert.strictEqual(densityLabel('answers-only'), 'Answers only');
        });
    });

    suite('detailsToggleLabel', () => {
        test('reads Show details when collapsed, Hide details when open', () => {
            assert.strictEqual(detailsToggleLabel(false), 'Show details');
            assert.strictEqual(detailsToggleLabel(true), 'Hide details');
        });
    });

    suite('type surface', () => {
        test('ChatDensity accepts exactly the three modes', () => {
            const modes: ChatDensity[] = ['comfortable', 'compact', 'answers-only'];
            assert.strictEqual(modes.length, 3);
        });
    });
});
