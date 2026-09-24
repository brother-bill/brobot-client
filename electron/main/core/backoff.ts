/**
 * How long to wait before reconnect attempt `n`.
 *
 * Exponential with "equal jitter": the delay doubles per failure up to a cap,
 * and half of it is randomised. The jitter matters more than it looks — after
 * a server deploy every streamer client drops at the same instant, and without
 * it they would all come back in lockstep, every time.
 *
 * The 2022 client retried every 5 s forever, which is both too slow when the
 * blip is one dropped packet and too fast when the server is down for an hour.
 */
export interface BackoffPolicy {
    /** Delay before the first retry. */
    readonly baseMs: number;
    /** Ceiling; a streamer whose server is down still reconnects within this. */
    readonly maxMs: number;
    /** A connection that stays up this long counts as stable and resets the count. */
    readonly stableAfterMs: number;
}

export const DEFAULT_BACKOFF: BackoffPolicy = {
    baseMs: 1000,
    maxMs: 60_000,
    stableAfterMs: 10_000,
};

/**
 * @param attempt 1 for the first retry after a failure, 2 for the second, …
 * @param random  a value in [0, 1); injected so the specs are deterministic.
 */
export function backoffDelay(attempt: number, policy: BackoffPolicy, random: number): number {
    const exponent = Math.max(0, attempt - 1);
    // 2 ** 30 overflows nothing but is already far past any sane cap; clamping
    // the exponent keeps a week-long outage from producing Infinity.
    const ceiling = Math.min(policy.maxMs, policy.baseMs * 2 ** Math.min(exponent, 30));
    const half = ceiling / 2;
    return Math.round(half + half * Math.min(Math.max(random, 0), 1));
}
