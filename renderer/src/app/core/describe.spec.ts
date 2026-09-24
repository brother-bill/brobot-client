import { describe, expect, it } from 'vitest';
import { INITIAL_CONNECTION_STATUS } from '@brobot-client/shared';
import { describeConnection, formatAgo, formatCountdown } from './describe';

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
