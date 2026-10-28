import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

import {
    encodeQr,
    getNumCodewords,
    getNumDataCodewords,
    pickVersion,
    reedSolomonComputeDivisor,
    reedSolomonComputeRemainder,
    toSvg,
} from '../../../shared/qrcode';

/**
 * Published total-codeword counts for versions 1–10 (ISO/IEC 18004 Table 1).
 * These anchor the block/ECC tables: if either table drifts, the derived data
 * capacity stops matching the spec and a phone camera would no longer decode
 * the symbol.
 */
const TOTAL_CODEWORDS = [26, 44, 70, 100, 134, 172, 196, 242, 292, 346];
/** Published level-M data-codeword capacities for versions 1–10. */
const M_DATA_CODEWORDS = [16, 28, 44, 64, 86, 108, 124, 154, 182, 216];

function moduleRows(matrix: { modules: boolean[][] }): string[] {
    return matrix.modules.map((row) => row.map((cell) => (cell ? '1' : '0')).join(''));
}

/** Minimal well-formedness check: balanced tags, quoted attributes, one root. */
function assertWellFormedXml(xml: string): void {
    const stack: string[] = [];
    let roots = 0;
    const tagPattern = /<(\/?)([A-Za-z][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*"[^"]*")*)\s*(\/?)>/g;
    let index = 0;
    let match: RegExpExecArray | null;
    while ((match = tagPattern.exec(xml)) !== null) {
        assert.strictEqual(match.index, index, `unexpected markup at offset ${match.index}`);
        index = tagPattern.lastIndex;
        const [, closing, name, , selfClosing] = match;
        if (closing) {
            assert.strictEqual(stack.pop(), name, `mismatched </${name}>`);
        } else if (selfClosing) {
            if (stack.length === 0) {
                roots++;
            }
        } else {
            if (stack.length === 0) {
                roots++;
            }
            stack.push(name!);
        }
    }
    assert.strictEqual(index, xml.length, 'trailing markup was not parsed');
    assert.deepStrictEqual(stack, [], 'unclosed tags');
    assert.strictEqual(roots, 1, 'expected exactly one root element');
}

/** Test-local GF(2^8) arithmetic — deliberately independent of the module. */
function gfMul(x: number, y: number): number {
    let z = 0;
    for (let i = 7; i >= 0; i--) {
        z = (z << 1) ^ ((z >>> 7) * 0x11d);
        z ^= ((y >>> i) & 1) * x;
    }
    return z & 0xff;
}

function gfPow(base: number, exponent: number): number {
    let result = 1;
    for (let i = 0; i < exponent; i++) {
        result = gfMul(result, base);
    }
    return result;
}

/** Evaluate a codeword polynomial at `x` (highest-degree coefficient first). */
function evalPoly(coefficients: readonly number[], x: number): number {
    let acc = 0;
    for (const coefficient of coefficients) {
        acc = gfMul(acc, x) ^ coefficient;
    }
    return acc;
}

suite('shared/qrcode', () => {
    test('block tables agree with the published codeword capacities', () => {
        for (let version = 1; version <= 10; version++) {
            assert.strictEqual(
                getNumCodewords(version),
                TOTAL_CODEWORDS[version - 1],
                `total codewords for version ${version}`
            );
            assert.strictEqual(
                getNumDataCodewords(version, 'M'),
                M_DATA_CODEWORDS[version - 1],
                `level-M data codewords for version ${version}`
            );
        }
    });

    test('version is chosen by payload length', () => {
        assert.strictEqual(pickVersion(1, 'M'), 1);
        assert.strictEqual(pickVersion(14, 'M'), 1);
        assert.strictEqual(pickVersion(15, 'M'), 2);
        assert.strictEqual(pickVersion(70, 'M'), 5);
        // A tunnel URL is longer than a loopback one, so it must pick a bigger symbol.
        const loopback = 'http://127.0.0.1:41234/?t=' + 'a'.repeat(43);
        const tunnel = 'https://tidy-otter-glances.trycloudflare.com/?t=' + 'a'.repeat(43);
        assert.ok(
            encodeQr(tunnel).version > encodeQr(loopback).version,
            'the long tunnel URL must select a larger version'
        );
    });

    test('oversized and empty inputs are rejected explicitly', () => {
        assert.throws(() => encodeQr(''), /empty input/);
        assert.throws(() => encodeQr('x'.repeat(500), { ecc: 'M' }), /does not fit/);
        assert.throws(() => encodeQr('x', { ecc: 'H' as never }), /unsupported ECC level/);
    });

    test('structural patterns are present and correctly placed', () => {
        const matrix = encodeQr('https://example.com/remote');
        const { size, modules } = matrix;
        assert.strictEqual(size, matrix.version * 4 + 17);

        const finderCentres = [
            [3, 3],
            [size - 4, 3],
            [3, size - 4],
        ];
        for (const [cx, cy] of finderCentres) {
            assert.strictEqual(modules[cy!]![cx!], true, 'finder centre must be dark');
            assert.strictEqual(modules[cy! + 1]![cx!], true, 'finder 3×3 core must be dark');
            assert.strictEqual(modules[cy! + 2]![cx!], false, 'finder inner ring must be light');
            assert.strictEqual(modules[cy! + 3]![cx!], true, 'finder outer ring must be dark');
        }

        // Timing patterns alternate on row 6 / column 6.
        for (let i = 8; i < size - 8; i++) {
            assert.strictEqual(modules[6]![i], i % 2 === 0, `horizontal timing at ${i}`);
            assert.strictEqual(modules[i]![6], i % 2 === 0, `vertical timing at ${i}`);
        }

        // The always-dark module sits above the bottom-left format copy.
        assert.strictEqual(modules[size - 8]![8], true, 'dark module must be set');

        // Version info exists for version >= 7 blocks and is mirrored.
        if (matrix.version >= 7) {
            const a = modules[0]![size - 11];
            const b = modules[size - 11]![0];
            assert.strictEqual(a, b, 'version-info copies must agree');
        }
    });

    test('both format-info copies agree and encode the chosen mask', () => {
        const matrix = encodeQr('format bits');
        const { size, modules } = matrix;
        let copy1 = 0;
        let copy2 = 0;
        const bit = (dark: boolean, index: number): void => {
            if (dark) {
                copy1 |= 1 << index;
            }
        };
        // Copy 1: 8 bits down column 8, then 7 bits along row 8.
        for (let i = 0; i <= 5; i++) bit(modules[i]![8]!, i);
        bit(modules[7]![8]!, 6);
        bit(modules[8]![8]!, 7);
        bit(modules[8]![7]!, 8);
        for (let i = 9; i < 15; i++) bit(modules[8]![14 - i]!, i);

        // Copy 2: 8 bits along row 8 at the right edge, then column 8 at the bottom.
        for (let i = 0; i < 8; i++) {
            if (modules[8]![size - 1 - i]) copy2 |= 1 << i;
        }
        for (let i = 8; i < 15; i++) {
            if (modules[size - 15 + i]![8]) copy2 |= 1 << i;
        }

        assert.strictEqual(copy1, copy2, 'the two format-info copies must match');
        // Undo the 0x5412 mask and check the 5 data bits survived the BCH round-trip.
        const unmasked = copy1 ^ 0x5412;
        const data = unmasked >>> 10;
        assert.strictEqual(data & 0b111, matrix.mask, 'mask bits must round-trip');
        assert.strictEqual((data >>> 3) & 0b11, 0b00, 'ECC level M format bits are 0b00');
    });

    test('Reed–Solomon codewords are divisible by the generator polynomial', () => {
        const divisor = reedSolomonComputeDivisor(10);
        assert.strictEqual(divisor.length, 10);
        const data = [32, 91, 11, 120, 209, 203, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        const remainder = reedSolomonComputeRemainder(data, divisor);
        assert.strictEqual(remainder.length, 10);
        const codeword = [...data, ...remainder];
        // A valid RS codeword evaluates to zero at the generator's roots
        // α^0…α^(degree-1) (the generator is ∏(x − α^i)); α^degree must NOT.
        for (let i = 0; i < 10; i++) {
            assert.strictEqual(evalPoly(codeword, gfPow(2, i)), 0, `root α^${i} must divide the codeword`);
        }
        // Guard against a trivially-zero remainder: flip one data byte and it must fail.
        const corrupted = [...data];
        corrupted[0] = corrupted[0]! ^ 0xff;
        assert.notStrictEqual(evalPoly([...corrupted, ...remainder], gfPow(2, 1)), 0);
    });

    test('encoding is deterministic and mask-scored', () => {
        const first = encodeQr('https://example.com/?t=abcdef');
        const second = encodeQr('https://example.com/?t=abcdef');
        assert.deepStrictEqual(moduleRows(first), moduleRows(second));
        assert.ok(first.mask >= 0 && first.mask <= 7);
        assert.strictEqual(first.ecc, 'M');
        // Different payloads must produce different symbols.
        assert.notDeepStrictEqual(moduleRows(first), moduleRows(encodeQr('https://example.com/?t=abcdeg')));
    });

    test('known-payload matrix snapshot', () => {
        // Golden snapshot: guards against layout regressions (a shifted zig-zag or
        // a mis-ordered block table changes every affected module).
        const matrix = encodeQr('ADO Code remote 0.8.1');
        assert.strictEqual(matrix.version, 2);
        assert.strictEqual(matrix.mask, 4);
        assert.deepStrictEqual(moduleRows(matrix), [
            '1111111011011011001111111',
            '1000001001110000001000001',
            '1011101001010001101011101',
            '1011101010101101001011101',
            '1011101010101001001011101',
            '1000001010010110001000001',
            '1111111010101010101111111',
            '0000000011011001100000000',
            '1000101110000010011111001',
            '0011010011010011010011101',
            '1001001101110111010000000',
            '0001000110110001011001110',
            '1010001111101010011100111',
            '1111110110000101100110001',
            '0000111000000001100101100',
            '0010010101001011000100100',
            '1111101000010110111110001',
            '0000000010101011100010001',
            '1111111010011110101010000',
            '1000001000010100100010100',
            '1011101010101100111110111',
            '1011101000100111111101111',
            '1011101001100000011100010',
            '1000001001001011001000110',
            '1111111011010111011010111',
        ]);
    });

    test('toSvg returns well-formed XML with a quiet zone', () => {
        const scale = 3;
        const border = 4;
        const svg = toSvg('https://example.com/remote', { scale, border });
        assertWellFormedXml(svg);
        assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
        assert.match(svg, /shape-rendering="crispEdges"/);
        assert.ok(!/xlink:href|href=|<image|@import|url\(/.test(svg), 'SVG must not reference external assets');

        const matrix = encodeQr('https://example.com/remote');
        const dim = (matrix.size + border * 2) * scale;
        assert.ok(svg.includes(`width="${dim}"`), 'declared width must include the quiet zone');
        assert.ok(svg.includes(`height="${dim}"`));

        // Every dark module is offset by the quiet zone.
        const xCoordinates = [...svg.matchAll(/M(\d+) /g)].map((m) => Number(m[1]));
        assert.ok(xCoordinates.length > 0);
        assert.ok(
            Math.min(...xCoordinates) >= border * scale,
            `dark modules must start at/after the quiet zone (min x ${Math.min(...xCoordinates)})`
        );
    });

    test('toSvg rejects invalid rendering options', () => {
        assert.throws(() => toSvg('x', { scale: 0 }), /scale/);
        assert.throws(() => toSvg('x', { border: -1 }), /border/);
    });

    test('encoder never imports vscode', () => {
        const source = fs.readFileSync(path.resolve(__dirname, '../../../../src/shared/qrcode.ts'), 'utf8');
        assert.ok(!/from\s+'vscode'/.test(source), 'qrcode.ts must not import vscode');
    });
});
