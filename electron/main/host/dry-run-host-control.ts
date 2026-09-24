import type { Clock } from '../core/clock';
import type { HostAction, HostActionKind, HostActionResult, HostControl } from './host-control';

/** One call the dry run received, for the specs and for the log. */
export interface DryRunCall {
    readonly kind: HostActionKind;
    readonly durationMs: number;
    readonly startedAt: number;
    endedAt: number | null;
    released: boolean;
}

/**
 * A HostControl that touches nothing. It keeps time exactly like the real one
 * — `done` resolves after `durationMs`, or on `release()` — so the command
 * runner, the countdown in the window and the reply to brobot all behave as
 * they would for real.
 */
export class DryRunHostControl implements HostControl {
    readonly kind = 'dry-run' as const;
    readonly calls: DryRunCall[] = [];

    constructor(
        private readonly clock: Clock,
        /** Makes the next action fail with this message, once (for the specs). */
        public failNext: string | null = null,
    ) {}

    blockEnter(durationMs: number): HostAction {
        return this.run('block-enter', durationMs);
    }

    muteMicrophone(durationMs: number): HostAction {
        return this.run('mute-microphone', durationMs);
    }

    private run(kind: HostActionKind, durationMs: number): HostAction {
        const call: DryRunCall = {
            kind,
            durationMs,
            startedAt: this.clock.now(),
            endedAt: null,
            released: false,
        };
        this.calls.push(call);

        if (this.failNext !== null) {
            const failure: HostActionResult = { ok: false, error: this.failNext };
            this.failNext = null;
            call.endedAt = call.startedAt;
            return { started: Promise.resolve(failure), done: Promise.resolve(failure), release: () => undefined };
        }

        let finish: (result: HostActionResult) => void = () => undefined;
        const done = new Promise<HostActionResult>(resolve => {
            finish = resolve;
        });
        const end = (released: boolean): void => {
            if (call.endedAt !== null) return;
            call.endedAt = this.clock.now();
            call.released = released;
            this.clock.clearTimeout(timer);
            finish({ ok: true, detail: released ? 'released early (dry run)' : 'dry run' });
        };
        const timer = this.clock.setTimeout(() => end(false), durationMs);

        return {
            started: Promise.resolve({ ok: true, detail: 'dry run' }),
            done,
            release: () => end(true),
        };
    }
}
