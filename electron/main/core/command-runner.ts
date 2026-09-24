/**
 * What happens when brobot asks for a ban: the policy (paused? this command
 * switched off?), the HostControl call, the log lines on both ends, and the
 * `*_complete` reply that resets the vote in chat.
 *
 * No Electron, no sockets: the host, the policy and the reply channel are all
 * injected, so `command-runner.spec.ts` drives it with the dry-run driver.
 *
 * ## Every ban brobot sends gets exactly one reply
 *
 * brobot's vote counter stays in "ban in progress" until the client says
 * `chatban_complete` / `voiceban_complete` (or disconnects). So a declined ban
 * is still answered — with an `error`, which brobot logs — or chat would never
 * be able to vote again. The one exception is a duplicate of a ban already
 * running: that one's reply is still coming.
 */

import {
    TEST_DURATION_MS,
    clampBanDuration,
    formatDuration,
    type ActiveBan,
    type BanCommand,
    type BanCompleteEvent,
    type LogSource,
    type LogTone,
} from '@brobot-client/shared';
import type { HostAction, HostActionResult, HostControl } from '../host/host-control';
import type { Clock } from './clock';
import type { BanEvent } from './connection';

export interface CommandPolicy {
    readonly commands: Readonly<Record<BanCommand, boolean>>;
    readonly paused: boolean;
}

export interface CommandRunnerOptions {
    readonly clock: Clock;
    /** The driver to use right now — the dry run while safe mode is on. */
    readonly host: () => HostControl;
    readonly policy: () => CommandPolicy;
    /** Sends the reply to brobot. May fail silently if the socket has gone. */
    readonly reply: (event: BanCompleteEvent) => void;
    readonly log: (source: LogSource, tone: LogTone, message: string) => void;
    readonly onActiveChange: (active: readonly ActiveBan[]) => void;
}

interface RunningBan {
    readonly id: number;
    readonly ban: ActiveBan;
    readonly action: HostAction;
    released: boolean;
}

/** The words for each command, in one place. */
const COPY: Readonly<
    Record<BanCommand, { name: string; applied: (d: string) => string; undone: string; failed: string }>
> = {
    chatban: {
        name: 'chatban',
        applied: d => `Blocked the Enter key for ${d}`,
        undone: 'Enter key unblocked',
        failed: 'Could not block the Enter key',
    },
    voiceban: {
        name: 'voiceban',
        applied: d => `Muted the microphone for ${d}`,
        undone: 'Microphone unmuted',
        failed: 'Could not mute the microphone',
    },
};

export class CommandRunner {
    private readonly running = new Map<number, RunningBan>();
    private nextId = 1;

    constructor(private readonly options: CommandRunnerOptions) {}

    get active(): readonly ActiveBan[] {
        return [...this.running.values()].map(r => r.ban);
    }

    /** A ban from brobot. Resolves once the ban is over and answered. */
    async handle(event: BanEvent): Promise<void> {
        const command = event.type;
        const copy = COPY[command];
        const { log, reply } = this.options;
        const duration = clampBanDuration(event.durationMs);
        log('bot', 'info', `brobot asked for a ${copy.name} (${formatDuration(event.durationMs)})`);

        const policy = this.options.policy();
        if (policy.paused) {
            log('app', 'warning', `Declined the ${copy.name}: commands are paused`);
            reply({ type: `${command}_complete`, error: 'Commands are paused on the streamer machine' });
            return;
        }
        if (!policy.commands[command]) {
            log('app', 'warning', `Declined the ${copy.name}: it is turned off in this app`);
            reply({ type: `${command}_complete`, error: `${copy.name} is turned off on the streamer machine` });
            return;
        }

        for (const running of this.running.values()) {
            if (running.ban.command !== command) continue;
            if (!running.ban.test) {
                log('app', 'info', `A ${copy.name} is already running; ignored the repeat`);
                return;
            }
            // A test of the same thing gives way to the real one.
            this.release(running);
        }

        if (duration !== event.durationMs) {
            log('app', 'warning', `Shortened to ${formatDuration(duration)}: the longest ban this app applies`);
        }

        const result = await this.run(command, duration, false);
        reply(result.ok ? { type: `${command}_complete` } : { type: `${command}_complete`, error: result.error });
    }

    /**
     * The window's Test button: the real action, briefly, with nothing sent
     * to brobot. Allowed while paused or switched off — it is the streamer's
     * own hand on the switch — but not on top of a real ban of the same kind.
     */
    async test(command: BanCommand): Promise<void> {
        const copy = COPY[command];
        for (const running of this.running.values()) {
            if (running.ban.command === command) {
                this.options.log('app', 'info', `Test skipped: a ${copy.name} is already running`);
                return;
            }
        }
        this.options.log('app', 'info', `Testing the ${copy.name} for ${formatDuration(TEST_DURATION_MS)}`);
        await this.run(command, TEST_DURATION_MS, true);
    }

    /** Ends every ban now. Each still logs its end and (if real) replies to brobot. */
    releaseAll(): void {
        for (const running of this.running.values()) this.release(running);
    }

    private release(running: RunningBan): void {
        if (running.released) return;
        running.released = true;
        running.action.release();
    }

    private async run(command: BanCommand, durationMs: number, test: boolean): Promise<HostActionResult> {
        const { clock, log } = this.options;
        const copy = COPY[command];
        const host = this.options.host();
        const dryRun = host.kind === 'dry-run';
        const action = command === 'chatban' ? host.blockEnter(durationMs) : host.muteMicrophone(durationMs);
        const startedAt = clock.now();
        const running: RunningBan = {
            id: this.nextId++,
            ban: { command, startedAt, endsAt: startedAt + durationMs, test, dryRun },
            action,
            released: false,
        };
        this.running.set(running.id, running);
        this.changed();

        const prefix = test ? 'Test: ' : '';
        const suffix = dryRun ? ' (safe mode: nothing was touched)' : '';
        const started = await action.started;
        if (started.ok) {
            log('host', 'success', `${prefix}${copy.applied(formatDuration(durationMs))}${suffix}`);
        }

        const result = await action.done;
        this.running.delete(running.id);
        this.changed();

        if (!started.ok) {
            log('host', 'error', `${prefix}${copy.failed}: ${started.error}`);
            return started;
        }
        if (!result.ok) {
            log('host', 'error', `${prefix}${copy.failed}: ${result.error}`);
            return result;
        }
        const early = running.released ? ' (released early)' : '';
        const detail = result.detail !== undefined && !dryRun ? ` — ${result.detail}` : '';
        log('host', 'success', `${prefix}${copy.undone}${early}${detail}`);
        return result;
    }

    private changed(): void {
        this.options.onActiveChange(this.active);
    }
}
