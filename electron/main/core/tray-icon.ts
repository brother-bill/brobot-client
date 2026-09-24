/**
 * The tray icons, drawn in code.
 *
 * Four small shapes do not justify a folder of binary assets, a path resolver
 * that has to work both from `dist/` and from inside an asar archive, and a
 * regeneration step nobody remembers. These are rasterised from signed
 * distance functions (anti-aliased by 4×4 supersampling) and encoded as PNG,
 * which `nativeImage.createFromBuffer` reads directly.
 *
 * Every glyph is a different SHAPE, not just a different colour (WCAG 1.4.1),
 * and every one has a dark outline so it reads on both the light and the dark
 * Windows 11 taskbar:
 *
 * - connected    — a filled green disc
 * - reconnecting — an amber ring (hollow: "not quite there")
 * - disconnected — a grey ring struck through
 * - paused       — two violet bars, the universal pause sign
 */

import type { TrayGlyph } from './tray-state';

type Rgb = readonly [number, number, number];

const OUTLINE: Rgb = [0x1f, 0x1f, 0x23];

const GLYPHS: Readonly<Record<TrayGlyph, { color: Rgb; sdf: (x: number, y: number) => number }>> = {
    connected: { color: [0x22, 0xc5, 0x5e], sdf: (x, y) => disc(x, y) },
    reconnecting: { color: [0xf5, 0x9e, 0x0b], sdf: (x, y) => ring(x, y) },
    disconnected: { color: [0xa1, 0xa1, 0xaa], sdf: (x, y) => Math.min(ring(x, y), slash(x, y)) },
    paused: {
        color: [0xa7, 0x8b, 0xfa],
        sdf: (x, y) => Math.min(box(x, y, 0.335, 0.5, 0.09, 0.3), box(x, y, 0.665, 0.5, 0.09, 0.3)),
    },
};

const RADIUS = 0.4;
const RING_WIDTH = 0.16;

function disc(x: number, y: number): number {
    return Math.hypot(x - 0.5, y - 0.5) - RADIUS;
}

function ring(x: number, y: number): number {
    return Math.abs(Math.hypot(x - 0.5, y - 0.5) - (RADIUS - RING_WIDTH / 2)) - RING_WIDTH / 2;
}

/** The strike-through: a segment from bottom-left to top-right of the ring. */
function slash(x: number, y: number): number {
    const [ax, ay, bx, by] = [0.24, 0.76, 0.76, 0.24];
    const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)));
    return Math.hypot(x - (ax + t * (bx - ax)), y - (ay + t * (by - ay))) - RING_WIDTH / 2;
}

function box(x: number, y: number, cx: number, cy: number, hw: number, hh: number): number {
    const dx = Math.abs(x - cx) - hw;
    const dy = Math.abs(y - cy) - hh;
    return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0);
}

/** Straight RGBA pixels, row-major, `size × size`. */
export function renderGlyph(glyph: TrayGlyph, size: number): Uint8Array {
    const { color, sdf } = GLYPHS[glyph];
    const outline = 1.25 / size;
    const samples = 4;
    const pixels = new Uint8Array(size * size * 4);
    for (let py = 0; py < size; py++) {
        for (let px = 0; px < size; px++) {
            let inner = 0;
            let outer = 0;
            for (let sy = 0; sy < samples; sy++) {
                for (let sx = 0; sx < samples; sx++) {
                    const d = sdf((px + (sx + 0.5) / samples) / size, (py + (sy + 0.5) / samples) / size);
                    if (d <= 0) inner++;
                    if (d <= outline) outer++;
                }
            }
            const total = samples * samples;
            const fill = inner / total;
            const alpha = outer / total;
            const offset = (py * size + px) * 4;
            for (let c = 0; c < 3; c++) {
                // Colour over outline, weighted by how much of the covered
                // area is the fill rather than the rim.
                const mix = alpha === 0 ? 0 : fill / alpha;
                pixels[offset + c] = Math.round(color[c] * mix + OUTLINE[c] * (1 - mix));
            }
            pixels[offset + 3] = Math.round(alpha * 255);
        }
    }
    return pixels;
}

export function trayIconPng(glyph: TrayGlyph, size: number): Uint8Array {
    return encodePng(renderGlyph(glyph, size), size, size);
}

// ── PNG ───────────────────────────────────────────────────────────────────
// A minimal encoder: 8-bit RGBA, no filtering, and a zlib stream of STORED
// (uncompressed) deflate blocks. A 32×32 icon is 4 KB either way, and this
// keeps the file free of Node's zlib so it runs in the specs as-is.

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    return table;
})();

export function crc32(bytes: Uint8Array): number {
    let crc = 0xffffffff;
    for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}

export function adler32(bytes: Uint8Array): number {
    let a = 1;
    let b = 0;
    for (const byte of bytes) {
        a = (a + byte) % 65521;
        b = (b + a) % 65521;
    }
    return ((b << 16) | a) >>> 0;
}

function zlibStored(data: Uint8Array): Uint8Array {
    const blockSize = 65535;
    const blocks = Math.max(1, Math.ceil(data.length / blockSize));
    const out = new Uint8Array(2 + blocks * 5 + data.length + 4);
    let o = 0;
    out[o++] = 0x78; // deflate, 32K window
    out[o++] = 0x01; // no preset dictionary, fastest; (0x78 << 8 | 0x01) % 31 === 0
    for (let i = 0; i < blocks; i++) {
        const chunk = data.subarray(i * blockSize, Math.min(data.length, (i + 1) * blockSize));
        out[o++] = i === blocks - 1 ? 1 : 0; // BFINAL, BTYPE=00 (stored)
        out[o++] = chunk.length & 0xff;
        out[o++] = chunk.length >>> 8;
        out[o++] = ~chunk.length & 0xff;
        out[o++] = (~chunk.length >>> 8) & 0xff;
        out.set(chunk, o);
        o += chunk.length;
    }
    writeUint32(out, o, adler32(data));
    return out;
}

function writeUint32(target: Uint8Array, offset: number, value: number): void {
    target[offset] = (value >>> 24) & 0xff;
    target[offset + 1] = (value >>> 16) & 0xff;
    target[offset + 2] = (value >>> 8) & 0xff;
    target[offset + 3] = value & 0xff;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
    const out = new Uint8Array(12 + data.length);
    writeUint32(out, 0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    writeUint32(out, 8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
}

export const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function encodePng(rgba: Uint8Array, width: number, height: number): Uint8Array {
    if (rgba.length !== width * height * 4) throw new Error('pixel buffer does not match the dimensions');
    const header = new Uint8Array(13);
    writeUint32(header, 0, width);
    writeUint32(header, 4, height);
    header[8] = 8; // bit depth
    header[9] = 6; // colour type: RGBA
    // compression, filter, interlace: all 0

    const rowBytes = width * 4;
    const raw = new Uint8Array(height * (rowBytes + 1));
    for (let y = 0; y < height; y++) {
        raw[y * (rowBytes + 1)] = 0; // filter: none
        raw.set(rgba.subarray(y * rowBytes, (y + 1) * rowBytes), y * (rowBytes + 1) + 1);
    }

    const parts = [PNG_SIGNATURE, chunk('IHDR', header), chunk('IDAT', zlibStored(raw)), chunk('IEND', new Uint8Array(0))];
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
}
