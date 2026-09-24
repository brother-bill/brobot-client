/**
 * Time, injected. Everything in `core/` that waits takes one of these so the
 * specs can run a five-minute ban or a sixty-second backoff instantly.
 */
export interface Clock {
    now(): number;
    setTimeout(callback: () => void, ms: number): TimerHandle;
    clearTimeout(handle: TimerHandle): void;
}

/** Opaque: whatever the clock's `setTimeout` returned. */
export type TimerHandle = unknown;

export const systemClock: Clock = {
    now: () => Date.now(),
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
