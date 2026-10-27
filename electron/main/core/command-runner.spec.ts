import { beforeEach, describe, expect, it } from 'vitest';
import {
    MAX_BAN_DURATION_MS,
    TEST_DURATION_MS,
    type ActiveBan,
    type BanCommand,
    type BanCompleteEvent,
    type LogSource,
    type LogTone,
    type VoicebanKeys,
} from '@brobot-client/shared';
import { DryRunHostControl } from '../host/dry-run-host-control';
import type { HostControl } from '../host/host-control';
import { FakeClock, settle } from '../testing/fake-clock';
import { CommandRunner, type CommandPolicy, type CommandRunnerOptions } from './command-runner';

describe('CommandRunner', () => {
    let clock: FakeClock;
    let host: DryRunHostControl;
    let policy: { commands: Record<BanCommand, boolean>; paused: boolean; voicebanKeys: VoicebanKeys };
    let replies: BanCompleteEvent[];
    let logs: { source: LogSource; tone: LogTone; message: string }[];
    let active: (readonly ActiveBan[])[];
    let runner: CommandRunner;

    beforeEach(() => {
        clock = new FakeClock();
        host = new DryRunHostControl(clock);
        policy = { commands: { chatban: true, voiceban: true }, paused: false, voicebanKeys: { start: 'none', end: 'none' } };
        replies = [];
        logs = [];
        active = [];
        runner = new CommandRunner(options());
    });

    const options = (): CommandRunnerOptions => ({
        clock,
        host: () => host,
        policy: (): CommandPolicy => policy,
        reply: event => replies.push(event),
        log: (source, tone, message) => logs.push({ source, tone, message }),
        onActiveChange: bans => active.push(bans),
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

    describe('the voiceban overlay keys', () => {
        beforeEach(() => {
            policy.voicebanKeys = { start: 'F8', end: 'F9' };
        });

        /** The dry run's timing, reporting itself as the real driver. */
        const live = (): HostControl => ({
            kind: 'windows',
            blockEnter: ms => host.blockEnter(ms),
            muteMicrophone: (ms, keys) => host.muteMicrophone(ms, keys),
        });

        it('in safe mode, says what it would press and presses nothing', async () => {
            const done = runner.handle({ type: 'voiceban', durationMs: 30_000 });
            await settle();
            expect(host.calls[0]?.keys).toEqual({ start: 'F8', end: 'F9' });
            clock.advance(30_000);
            await done;
            expect(messages()).toEqual([
                'brobot asked for a voiceban (30 s)',
                'Muted the microphone for 30 s (safe mode: nothing was touched)',
                'Would press F8 (overlay on) (safe mode: nothing was pressed)',
                'Microphone unmuted',
                'Would press F9 (overlay off) (safe mode: nothing was pressed)',
            ]);
        });

        it('logs F8 as the ban starts and F9 when its time is up', async () => {
            runner = new CommandRunner({ ...options(), host: live });
            const done = runner.handle({ type: 'voiceban', durationMs: 30_000 });
            await settle();
            expect(messages()).toContain('Pressed F8 (overlay on)');
            expect(messages()).not.toContain('Pressed F9 (overlay off)');
            clock.advance(30_000);
            await done;
            expect(messages().slice(-2)).toEqual(['Microphone unmuted — dry run', 'Pressed F9 (overlay off)']);
            expect(replies).toEqual([{ type: 'voiceban_complete' }]);
        });

        it('logs F9 when the ban is stopped early (Release now, or the app quitting)', async () => {
            runner = new CommandRunner({ ...options(), host: live });
            const done = runner.handle({ type: 'voiceban', durationMs: 30_000 });
            await settle();
            runner.releaseAll();
            await done;
            expect(messages().at(-1)).toBe('Pressed F9 (overlay off)');
        });

        it('logs both keys for the Test button, which presses them for real outside safe mode', async () => {
            runner = new CommandRunner({ ...options(), host: live });
            const done = runner.test('voiceban');
            await settle();
            clock.advance(TEST_DURATION_MS);
            await done;
            expect(messages()).toContain('Test: Pressed F8 (overlay on)');
            expect(messages().at(-1)).toBe('Test: Pressed F9 (overlay off)');
        });

        it('presses nothing for a chatban, or for keys set to none', async () => {
            policy.voicebanKeys = { start: 'none', end: 'F9' };
            const voice = runner.handle({ type: 'voiceban', durationMs: 1000 });
            const chat = runner.handle({ type: 'chatban', durationMs: 1000 });
            clock.advance(1000);
            await Promise.all([voice, chat]);
            expect(messages().filter(m => m.includes('press'))).toEqual([
                'Would press F9 (overlay off) (safe mode: nothing was pressed)',
            ]);
        });

        it('warns when Windows refused a key', async () => {
            const refusing: HostControl = {
                kind: 'windows',
                blockEnter: ms => host.blockEnter(ms),
                muteMicrophone: () => ({
                    started: Promise.resolve({
                        ok: true,
                        keys: [{ when: 'start', key: 'F8', ok: false, error: 'Windows refused the key press (error 5)' }],
                    }),
                    done: Promise.resolve({ ok: true }),
                    release: () => undefined,
                }),
            };
            runner = new CommandRunner({ ...options(), host: () => refusing });
            await runner.handle({ type: 'voiceban', durationMs: 1000 });
            expect(logs).toContainEqual({
                source: 'host',
                tone: 'warning',
                message: 'Could not press F8 (overlay on): Windows refused the key press (error 5)',
            });
        });
    });

    it('publishes the active list as it changes', async () => {
        const done = runner.handle({ type: 'voiceban', durationMs: 30_000 });
        await settle();
        clock.advance(30_000);
        await done;
        expect(active.map(list => list.length)).toEqual([1, 0]);
    });
});
