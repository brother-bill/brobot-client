import { describe, expect, it } from 'vitest';
import type { TrayGlyph } from './tray-state';
import { PNG_SIGNATURE, adler32, crc32, encodePng, renderGlyph, trayIconPng } from './tray-icon';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const u32 = (b: Uint8Array, at: number): number => ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0;

describe('the PNG encoder', () => {
    it('computes the checksums PNG and zlib specify', () => {
        expect(crc32(bytes('IEND'))).toBe(0xae426082);
        expect(adler32(bytes('Wikipedia'))).toBe(0x11e60398);
    });

    it('writes a well-formed RGBA PNG', () => {
        const png = encodePng(new Uint8Array(2 * 3 * 4).fill(255), 2, 3);
        expect(png.subarray(0, 8)).toEqual(PNG_SIGNATURE);
        expect(new TextDecoder().decode(png.subarray(12, 16))).toBe('IHDR');
        expect(u32(png, 16)).toBe(2);
        expect(u32(png, 20)).toBe(3);
        expect(png[24]).toBe(8);
        expect(png[25]).toBe(6);
        // Every chunk's CRC covers its type and data.
        let offset = 8;
        const types: string[] = [];
        while (offset < png.length) {
            const length = u32(png, offset);
            types.push(new TextDecoder().decode(png.subarray(offset + 4, offset + 8)));
            expect(u32(png, offset + 8 + length)).toBe(crc32(png.subarray(offset + 4, offset + 8 + length)));
            offset += 12 + length;
        }
        expect(types).toEqual(['IHDR', 'IDAT', 'IEND']);
    });

    it('refuses a buffer that does not match its dimensions', () => {
        expect(() => encodePng(new Uint8Array(3), 1, 1)).toThrow();
    });
});

describe('the tray glyphs', () => {
    const alphaAt = (glyph: TrayGlyph, x: number, y: number, size = 32): number =>
        renderGlyph(glyph, size)[(y * size + x) * 4 + 3]!;

    it('leave the corners transparent', () => {
        for (const glyph of ['connected', 'reconnecting', 'disconnected', 'paused'] as const) {
            expect(alphaAt(glyph, 0, 0)).toBe(0);
            expect(alphaAt(glyph, 31, 31)).toBe(0);
        }
    });

    it('differ by shape, not only by colour', () => {
        // Centre: the disc is solid, the ring hollow, the struck ring crossed,
        // and the pause sign has a gap between its bars.
        expect(alphaAt('connected', 16, 16)).toBe(255);
        expect(alphaAt('reconnecting', 16, 16)).toBe(0);
        expect(alphaAt('disconnected', 16, 16)).toBe(255);
        expect(alphaAt('paused', 16, 16)).toBe(0);
        expect(alphaAt('paused', 10, 16)).toBe(255);
    });

    it('encode at both tray sizes', () => {
        expect(u32(trayIconPng('connected', 16), 16)).toBe(16);
        expect(u32(trayIconPng('paused', 32), 16)).toBe(32);
    });
});
