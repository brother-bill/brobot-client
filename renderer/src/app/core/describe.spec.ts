import { describe, expect, it } from 'vitest';
import { INITIAL_CONNECTION_STATUS } from '@brobot-client/shared';
import {
    describeConnection,
    describeShortcut,
    describeStreamOverlay,
    formatAgo,
    formatCountdown,
    overlayNotice,
    pressedReminder,
} from './describe';

const URL = 'wss://admin.brobot.live/api/ashketchum';

describe('describeConnection', () => {
    it('says where it is listening when connected', () => {
        expect(describeConnection({ ...INITIAL_CONNECTION_STATUS, state: 'connected' }, URL, true, 0)).toEqual({
            dot: 'nominal',
            label: 'Connected',
            detail: 'Listening to brobot at admin.brobot.live.',
        });
    });

    it('counts down to the next attempt and says why the last one failed', () => {
        const view = describeConnection(
            {
                ...INITIAL_CONNECTION_STATUS,
                state: 'reconnecting',
                attempt: 3,
                nextRetryAt: 12_000,
                lastError: 'brobot refused the secret — check it in Settings',
            },
            URL,
            true,
            1_000,
        );
        expect(view.dot).toBe('fault');
        expect(view.detail).toBe(
            'brobot refused the secret — check it in Settings. Trying again in 11 s (attempt 3).',
        );
    });

    it('sends an unconfigured app to Settings', () => {
        expect(describeConnection(INITIAL_CONNECTION_STATUS, URL, false, 0).detail).toBe(
            'Enter the server address and the secret in Settings to connect.',
        );
    });
});

describe('describeStreamOverlay', () => {
    it('says connected when brobot sees a browser source', () => {
        expect(describeStreamOverlay(1)).toEqual({ dot: 'nominal', label: 'Overlay: connected', problem: false });
        expect(describeStreamOverlay(2).label).toBe('Overlay: connected');
    });

    it('says what is lost when brobot sees none', () => {
        expect(describeStreamOverlay(0)).toEqual({
            dot: 'fault',
            label: 'Overlay: not connected — roars and quacks will be refunded',
            problem: true,
        });
    });

    it('says unknown, not "not connected", until brobot says (an older brobot never does)', () => {
        expect(describeStreamOverlay(null)).toEqual({ dot: 'idle', label: 'Overlay: unknown', problem: false });
    });
});

describe('formatCountdown / formatAgo', () => {
    it('reads like a clock, never negative', () => {
        expect(formatCountdown(299_001)).toBe('5:00');
        expect(formatCountdown(65_000)).toBe('1:05');
        expect(formatCountdown(-5)).toBe('0:00');
    });

    it('says "just now" for the last second', () => {
        expect(formatAgo(400)).toBe('just now');
        expect(formatAgo(14_000)).toBe('14 s ago');
    });
});

describe('key binding copy', () => {
    it("tells the streamer exactly what Streamlabs/OBS must do before a voiceban key changes", () => {
        expect(overlayNotice('voiceban_start', 'F10')).toBe(
            'Streamlabs/OBS must have F10 bound to the overlay. Update the hotkey in Streamlabs → Settings → Hotkeys ' +
                '(or OBS → Settings → Hotkeys) or the overlay will stop switching.',
        );
        expect(overlayNotice('voiceban_end', 'none')).toMatch(/^brobot will stop pressing a key as a voiceban ends/);
    });

    it('keeps a reminder beside each voiceban key', () => {
        expect(pressedReminder('voiceban_start', 'F8')).toBe('Streamlabs/OBS must have F8 bound to show the voiceban overlay.');
        expect(pressedReminder('voiceban_end', 'Ctrl+num9')).toBe(
            'Streamlabs/OBS must have Ctrl+Num 9 bound to hide the voiceban overlay.',
        );
        expect(pressedReminder('voiceban_end', 'none')).toBe('Off: brobot presses nothing as a voiceban ends.');
    });

    it('says plainly when a shortcut is not working', () => {
        expect(describeShortcut({ state: 'taken', combo: 'Ctrl+Alt+F4' })).toEqual({
            text: expect.stringContaining('another app already uses Ctrl+Alt+F4') as string,
            problem: true,
        });
        expect(describeShortcut({ state: 'active', combo: 'Ctrl+Alt+F5' }).problem).toBe(false);
    });
});
