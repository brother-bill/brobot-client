import type { Clock, TimerHandle } from '../core/clock';

/** A clock the specs move by hand. Timers fire in order, at their own time. */
export class FakeClock implements Clock {
    time = 1_700_000_000_000;
    private nextId = 1;
    private timers: { id: number; at: number; callback: () => void }[] = [];

    now(): number {
        return this.time;
    }

    setTimeout(callback: () => void, ms: number): TimerHandle {
        const id = this.nextId++;
        this.timers.push({ id, at: this.time + ms, callback });
        return id;
    }

    clearTimeout(handle: TimerHandle): void {
        this.timers = this.timers.filter(t => t.id !== handle);
    }

    get pending(): number {
        return this.timers.length;
    }

    /** Moves time forward, firing every timer due on the way, earliest first. */
    advance(ms: number): void {
        const target = this.time + ms;
        for (;;) {
            const due = this.timers.filter(t => t.at <= target).sort((a, b) => a.at - b.at || a.id - b.id).at(0);
            if (due === undefined) break;
            this.timers = this.timers.filter(t => t !== due);
            this.time = due.at;
            due.callback();
        }
        this.time = target;
    }
}

/** Lets pending promise callbacks run. */
export async function settle(): Promise<void> {
    for (let i = 0; i < 20; i++) await Promise.resolve();
}
