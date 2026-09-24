import { describe, expect, it } from 'vitest';
import {
    MAX_BAN_DURATION_MS,
    MIN_BAN_DURATION_MS,
    clampBanDuration,
    formatDuration,
    parseStreamerServerEvent,
} from './server-events';
import { CHATBAN_DURATION_MS, VOICEBAN_DURATION_MS } from './streamer-events';

describe('parseStreamerServerEvent', () => {
    it('reads a chatban with its duration', () => {
        expect(parseStreamerServerEvent('{"type":"chatban","durationMs":300000}')).toEqual({
            type: 'chatban',
            durationMs: 300000,
        });
    });

    it('gives a ban without a duration the default the chat copy promises', () => {
        expect(parseStreamerServerEvent('{"type":"chatban"}')).toEqual({
            type: 'chatban',
            durationMs: CHATBAN_DURATION_MS,
        });
        expect(parseStreamerServerEvent('{"type":"voiceban","durationMs":"30s"}')).toEqual({
            type: 'voiceban',
            durationMs: VOICEBAN_DURATION_MS,
        });
        expect(parseStreamerServerEvent('{"type":"voiceban","durationMs":-5}')).toEqual({
            type: 'voiceban',
            durationMs: VOICEBAN_DURATION_MS,
        });
    });

    it('reads a ping and requires its timestamp', () => {
        expect(parseStreamerServerEvent('{"type":"ping","sentAt":123}')).toEqual({ type: 'ping', sentAt: 123 });
        expect(parseStreamerServerEvent('{"type":"ping"}')).toBeNull();
    });

    it('ignores unknown types, the 2022 frame shape, and anything that is not an object', () => {
        expect(parseStreamerServerEvent('{"type":"overlay"}')).toBeNull();
        expect(parseStreamerServerEvent('{"event":"chatban","data":null}')).toBeNull();
        expect(parseStreamerServerEvent('not json')).toBeNull();
        expect(parseStreamerServerEvent('["chatban"]')).toBeNull();
        expect(parseStreamerServerEvent('null')).toBeNull();
    });
});

describe('clampBanDuration', () => {
    it('keeps a sane duration and bounds a hostile one', () => {
        expect(clampBanDuration(30_000)).toBe(30_000);
        expect(clampBanDuration(24 * 60 * 60 * 1000)).toBe(MAX_BAN_DURATION_MS);
        expect(clampBanDuration(1)).toBe(MIN_BAN_DURATION_MS);
    });
});

describe('formatDuration', () => {
    it('says seconds, minutes, or both', () => {
        expect(formatDuration(5000)).toBe('5 s');
        expect(formatDuration(300_000)).toBe('5 min');
        expect(formatDuration(90_000)).toBe('1 min 30 s');
    });
});
