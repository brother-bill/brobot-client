import { describe, expect, it } from 'vitest';
import { DEFAULT_BACKOFF, backoffDelay } from './backoff';

describe('backoffDelay', () => {
    it('doubles per attempt, with half of each delay jittered', () => {
        expect(backoffDelay(1, DEFAULT_BACKOFF, 0)).toBe(500);
        expect(backoffDelay(1, DEFAULT_BACKOFF, 0.999999)).toBe(1000);
        expect(backoffDelay(2, DEFAULT_BACKOFF, 0)).toBe(1000);
        expect(backoffDelay(3, DEFAULT_BACKOFF, 0)).toBe(2000);
        expect(backoffDelay(4, DEFAULT_BACKOFF, 1)).toBe(8000);
    });

    it('stops growing at the cap, however long the outage', () => {
        expect(backoffDelay(7, DEFAULT_BACKOFF, 1)).toBe(DEFAULT_BACKOFF.maxMs);
        expect(backoffDelay(10_000, DEFAULT_BACKOFF, 1)).toBe(DEFAULT_BACKOFF.maxMs);
        expect(backoffDelay(10_000, DEFAULT_BACKOFF, 0)).toBe(DEFAULT_BACKOFF.maxMs / 2);
    });

    it('treats attempt 0 like the first retry, and clamps a bad random', () => {
        expect(backoffDelay(0, DEFAULT_BACKOFF, 0)).toBe(500);
        expect(backoffDelay(1, DEFAULT_BACKOFF, 5)).toBe(1000);
        expect(backoffDelay(1, DEFAULT_BACKOFF, -1)).toBe(500);
    });
});
