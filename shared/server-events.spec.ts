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

    it("reads brobot's answer to a hotkey, with its error line when there is one", () => {
        expect(parseStreamerServerEvent('{"type":"create_marker_complete"}')).toEqual({ type: 'create_marker_complete' });
        expect(parseStreamerServerEvent('{"type":"play_ad_complete","error":"not live"}')).toEqual({
            type: 'play_ad_complete',
            error: 'not live',
        });
        expect(parseStreamerServerEvent('{"type":"create_prediction_complete","error":""}')).toEqual({
            type: 'create_prediction_complete',
        });
        expect(parseStreamerServerEvent('{"type":"create_marker_complete","error":42}')).toEqual({
            type: 'create_marker_complete',
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

    it('reads how many stream overlays brobot sees, and nothing that is not a count', () => {
        expect(parseStreamerServerEvent('{"type":"overlay_status","connected":0}')).toEqual({
            type: 'overlay_status',
            connected: 0,
        });
        expect(parseStreamerServerEvent('{"type":"overlay_status","connected":2}')).toEqual({
            type: 'overlay_status',
            connected: 2,
        });
        expect(parseStreamerServerEvent('{"type":"overlay_status"}')).toBeNull();
        expect(parseStreamerServerEvent('{"type":"overlay_status","connected":true}')).toBeNull();
        expect(parseStreamerServerEvent('{"type":"overlay_status","connected":-1}')).toBeNull();
        expect(parseStreamerServerEvent('{"type":"overlay_status","connected":1.5}')).toBeNull();
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

describe('horror frames (SLEEP TIGHT)', () => {
    it('reads a known effect and who redeemed it', () => {
        expect(parseStreamerServerEvent('{"type":"horror","effect":"scream","user":"Ash"}')).toEqual({ type: 'horror', effect: 'scream', user: 'Ash' });
        expect(parseStreamerServerEvent('{"type":"horror","effect":"jumpscare"}')).toEqual({ type: 'horror', effect: 'jumpscare', user: '' });
    });

    it('ignores unknown effects and malformed frames', () => {
        expect(parseStreamerServerEvent('{"type":"horror","effect":"format_c"}')).toBeNull();
        expect(parseStreamerServerEvent('{"type":"horror"}')).toBeNull();
        expect(parseStreamerServerEvent('{"type":"horror","effect":7}')).toBeNull();
    });
});
