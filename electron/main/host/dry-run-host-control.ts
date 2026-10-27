import type { KeyCombo, VoicebanKeys } from '@brobot-client/shared';
import type { Clock } from '../core/clock';
import type { HostAction, HostActionKind, HostActionResult, HostControl, KeyPress } from './host-control';

/** One call the dry run received, for the specs and for the log. */
export interface DryRunCall {
    readonly kind: HostActionKind;
    readonly durationMs: number;
    /** The overlay keys a mute was asked to press. */
    readonly keys?: VoicebanKeys;
    readonly startedAt: number;
    endedAt: number | null;
    released: boolean;
}

/**
 * A HostControl that touches nothing. It keeps time exactly like the real one
 * — `done` resolves after `durationMs`, or on `release()` — so the command
 * runner, the countdown in the window and the reply to brobot all behave as
 * they would for real. Overlay keys are reported as pressed, at the same two
 * moments, so the log can say which keys it would have pressed.
 */
export class DryRunHostControl implements HostControl {
    readonly kind = 'dry-run' as const;
    readonly calls: DryRunCall[] = [];
    /** Every combination {@link pressKey} was asked to press. */
    readonly presses: KeyCombo[] = [];

    constructor(
        private readonly clock: Clock,
        /** Makes the next action fail with this message, once (for the specs). */
        public failNext: string | null = null,
    ) {}

    blockEnter(durationMs: number): HostAction {
        return this.run('block-enter', durationMs, null);
    }

    muteMicrophone(durationMs: number, keys: VoicebanKeys): HostAction {
        return this.run('mute-microphone', durationMs, keys);
    }

    pressKey(combo: KeyCombo): Promise<HostActionResult> {
        this.presses.push(combo);
        if (this.failNext !== null) {
            const error = this.failNext;
            this.failNext = null;
            return Promise.resolve({ ok: false, error });
        }
        return Promise.resolve({ ok: true, detail: 'dry run' });
    }

    private run(kind: HostActionKind, durationMs: number, keys: VoicebanKeys | null): HostAction {
        const call: DryRunCall = {
            kind,
            durationMs,
            ...(keys === null ? {} : { keys }),
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

        // What would have been pressed, and when.
        const withPress = (result: HostActionResult, when: KeyPress['when']): HostActionResult => {
            const key = keys?.[when] ?? 'none';
            return key === 'none' ? result : { ...result, keys: [{ when, key, ok: true }] };
        };
        let finish: (result: HostActionResult) => void = () => undefined;
        const done = new Promise<HostActionResult>(resolve => {
            finish = resolve;
        });
        const end = (released: boolean): void => {
            if (call.endedAt !== null) return;
            call.endedAt = this.clock.now();
            call.released = released;
            this.clock.clearTimeout(timer);
            finish(withPress({ ok: true, detail: released ? 'released early (dry run)' : 'dry run' }, 'end'));
        };
        const timer = this.clock.setTimeout(() => end(false), durationMs);

        return {
            started: Promise.resolve(withPress({ ok: true, detail: 'dry run' }, 'start')),
            done,
            release: () => end(true),
        };
    }
}
