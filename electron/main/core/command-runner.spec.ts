import { beforeEach, describe, expect, it } from 'vitest';
import {
    MAX_BAN_DURATION_MS,
    TEST_DURATION_MS,
    type ActiveBan,
    type BanCommand,
    type BanCompleteEvent,
    type LogSource,
    type LogTone,
} from '@brobot-client/shared';
import { DryRunHostControl } from '../host/dry-run-host-control';
import { FakeClock, settle } from '../testing/fake-clock';
import { CommandRunner, type CommandPolicy } from './command-runner';

describe('CommandRunner', () => {
    let clock: FakeClock;
    let host: DryRunHostControl;
    let policy: { commands: Record<BanCommand, boolean>; paused: boolean };
    let replies: BanCompleteEvent[];
    let logs: { source: LogSource; tone: LogTone; message: string }[];
    let active: (readonly ActiveBan[])[];
    let runner: CommandRunner;

    beforeEach(() => {
        clock = new FakeClock();
        host = new DryRunHostControl(clock);
        policy = { commands: { chatban: true, voiceban: true }, paused: false };
        replies = [];
        logs = [];
        active = [];
        runner = new CommandRunner({
            clock,
            host: () => host,
            policy: (): CommandPolicy => policy,
            reply: event => replies.push(event),
            log: (source, tone, message) => logs.push({ source, tone, message }),
            onActiveChange: bans => active.push(bans),
        });
    });

    const messages = (): string[] => logs.map(l => l.message);

    it('blocks Enter for the requested time, then tells brobot it is over', async () => {
        const done = runner.handle({ type: 'chatban', durationMs: 300_000 });
        await settle();
        expect(host.calls).toMatchObject([{ kind: 'block-enter', durationMs: 300_000 }]);
        expect(runner.active).toMatchObject([{ command: 'chatban', test: false, dryRun: true }]);
        expect(runner.active[0]!.endsAt - runner.active[0]!.startedAt).toBe(300_000);
        expect(replies).toEqual([]);

        clock.advance(300_000);
        await done;
        expect(replies).toEqual([{ type: 'chatban_complete' }]);
        expect(runner.active).toEqual([]);
        expect(messages()).toEqual([
            'brobot asked for a chatban (5 min)',
            'Blocked the Enter key for 5 min (safe mode: nothing was touched)',
            'Enter key unblocked',
        ]);
        expect(logs.map(l => l.source)).toEqual(['bot', 'host', 'host']);
    });

    it('mutes the microphone for a voiceban', async () => {
        const done = runner.handle({ type: 'voiceban', durationMs: 30_000 });
        await settle();
        expect(host.calls[0]?.kind).toBe('mute-microphone');
        clock.advance(30_000);
        await done;
        expect(replies).toEqual([{ type: 'voiceban_complete' }]);
    });

    it('declines while paused — and still answers, so chat can vote again', async () => {
        policy.paused = true;
        await runner.handle({ type: 'chatban', durationMs: 300_000 });
        expect(host.calls).toHaveLength(0);
        expect(replies).toEqual([
            { type: 'chatban_complete', error: 'Commands are paused on the streamer machine' },
        ]);
        expect(logs.at(-1)).toMatchObject({ tone: 'warning', message: 'Declined the chatban: commands are paused' });
    });

    it('declines a command switched off, and only that one', async () => {
        policy.commands.voiceban = false;
        await runner.handle({ type: 'voiceban', durationMs: 30_000 });
        expect(replies).toEqual([
            { type: 'voiceban_complete', error: 'voiceban is turned off on the streamer machine' },
        ]);
        void runner.handle({ type: 'chatban', durationMs: 1000 });
        await settle();
        expect(host.calls.map(c => c.kind)).toEqual(['block-enter']);
    });

    it('ignores a repeat of a ban already running — its reply is still coming', async () => {
        const first = runner.handle({ type: 'chatban', durationMs: 60_000 });
        await settle();
        await runner.handle({ type: 'chatban', durationMs: 60_000 });
        expect(host.calls).toHaveLength(1);
        clock.advance(60_000);
        await first;
        expect(replies).toEqual([{ type: 'chatban_complete' }]);
    });

    it('will not apply a ban longer than the cap, whatever the server says', async () => {
        void runner.handle({ type: 'chatban', durationMs: 24 * 60 * 60 * 1000 });
        await settle();
        expect(host.calls[0]?.durationMs).toBe(MAX_BAN_DURATION_MS);
        expect(messages()).toContain('Shortened to 15 min: the longest ban this app applies');
    });

    it('reports a host failure to the log and to brobot', async () => {
        host.failNext = 'Windows refused the keyboard hook (error 5)';
        await runner.handle({ type: 'chatban', durationMs: 1000 });
        expect(replies).toEqual([
            { type: 'chatban_complete', error: 'Windows refused the keyboard hook (error 5)' },
        ]);
        expect(logs.at(-1)).toEqual({
            source: 'host',
            tone: 'error',
            message: 'Could not block the Enter key: Windows refused the keyboard hook (error 5)',
        });
        expect(logs.filter(l => l.tone === 'error')).toHaveLength(1);
    });

    it('releases early on request, and still replies', async () => {
        const done = runner.handle({ type: 'chatban', durationMs: 300_000 });
        await settle();
        clock.advance(10_000);
        runner.releaseAll();
        await done;
        expect(host.calls[0]?.released).toBe(true);
        expect(replies).toEqual([{ type: 'chatban_complete' }]);
        expect(logs.at(-1)?.message).toBe('Enter key unblocked (released early)');
    });

    it('tests briefly, even while paused, without telling brobot', async () => {
        policy.paused = true;
        const done = runner.test('voiceban');
        await settle();
        expect(host.calls).toMatchObject([{ kind: 'mute-microphone', durationMs: TEST_DURATION_MS }]);
        expect(runner.active[0]?.test).toBe(true);
        clock.advance(TEST_DURATION_MS);
        await done;
        expect(replies).toEqual([]);
        expect(messages()).toEqual([
            'Testing the voiceban for 5 s',
            'Test: Muted the microphone for 5 s (safe mode: nothing was touched)',
            'Test: Microphone unmuted',
        ]);
    });

    it('lets a real ban take over from a test of the same command', async () => {
        const test = runner.test('chatban');
        await settle();
        const real = runner.handle({ type: 'chatban', durationMs: 60_000 });
        await settle();
        await test;
        expect(host.calls.map(c => c.released)).toEqual([true, false]);
        expect(runner.active).toMatchObject([{ command: 'chatban', test: false }]);
        clock.advance(60_000);
        await real;
        expect(replies).toEqual([{ type: 'chatban_complete' }]);
    });

    it('skips a test while the real thing is running', async () => {
        void runner.handle({ type: 'chatban', durationMs: 60_000 });
        await settle();
        await runner.test('chatban');
        expect(host.calls).toHaveLength(1);
        expect(logs.at(-1)?.message).toBe('Test skipped: a chatban is already running');
    });

    it('publishes the active list as it changes', async () => {
        const done = runner.handle({ type: 'voiceban', durationMs: 30_000 });
        await settle();
        clock.advance(30_000);
        await done;
        expect(active.map(list => list.length)).toEqual([1, 0]);
    });
});
