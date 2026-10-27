import { beforeEach, describe, expect, it } from 'vitest';
import { FakeClock, settle } from '../testing/fake-clock';
import type { HostActionResult } from './host-control';
import { POWERSHELL, WindowsHostControl, type ShimProcess } from './windows-host-control';

type Listener = (...args: never[]) => void;

const KEYS = { start: 'F8', end: 'F9' } as const;
const NO_KEYS = { start: 'none', end: 'none' } as const;
const DEVICE = '{0.0.1.00000000}.{8f1c2a3b-0000-4000-8000-000000000001}';

class FakeProcess implements ShimProcess {
    readonly written: string[] = [];
    stdinEnded = false;
    killed = false;
    private readonly listeners = new Map<string, Listener[]>();

    constructor(
        readonly command: string,
        readonly args: readonly string[],
    ) {}

    readonly stdout = { on: (_event: 'data', listener: (chunk: { toString(): string }) => void) => this.add('stdout', listener) };
    readonly stderr = { on: (_event: 'data', listener: (chunk: { toString(): string }) => void) => this.add('stderr', listener) };
    readonly stdin = {
        write: (data: string) => this.written.push(data),
        end: () => {
            this.stdinEnded = true;
        },
    };

    on(event: 'exit' | 'error', listener: Listener): this {
        this.add(event, listener);
        return this;
    }

    kill(): void {
        this.killed = true;
    }

    /** The script PowerShell would run, decoded from -EncodedCommand. */
    get script(): string {
        const encoded = this.args[this.args.indexOf('-EncodedCommand') + 1]!;
        const binary = atob(encoded);
        let text = '';
        for (let i = 0; i < binary.length; i += 2) {
            text += String.fromCharCode(binary.charCodeAt(i) | (binary.charCodeAt(i + 1) << 8));
        }
        return text;
    }

    out(text: string): void {
        this.emit('stdout', { toString: () => text });
    }

    err(text: string): void {
        this.emit('stderr', { toString: () => text });
    }

    exit(code: number | null): void {
        this.emit('exit', code, null);
    }

    private add(event: string, listener: Listener): void {
        this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    }

    private emit(event: string, ...args: unknown[]): void {
        for (const listener of this.listeners.get(event) ?? []) (listener as (...a: unknown[]) => void)(...args);
    }
}

describe('WindowsHostControl', () => {
    let clock: FakeClock;
    let processes: FakeProcess[];
    let host: WindowsHostControl;

    const latest = (): FakeProcess => processes[processes.length - 1]!;

    beforeEach(() => {
        clock = new FakeClock();
        processes = [];
        host = new WindowsHostControl({
            clock,
            parentPid: 4242,
            spawn: (command, args) => {
                const child = new FakeProcess(command, args);
                processes.push(child);
                return child;
            },
        });
    });

    it('runs the keyboard shim in a hidden, profile-less PowerShell', () => {
        host.blockEnter(300_000);
        expect(latest().command).toBe(POWERSHELL);
        expect(latest().args).toEqual(expect.arrayContaining(['-NoProfile', '-NonInteractive', '-InputFormat', 'None']));
        expect(latest().script).toContain('exit [Brobot.Shim]::BlockEnter(300000, 4242)');
    });

    it('is started on READY and done on DONE + exit 0', async () => {
        const action = host.blockEnter(1000);
        let started: HostActionResult | null = null;
        void action.started.then(r => (started = r));
        await settle();
        expect(started).toBeNull();

        latest().out('READY\r\n');
        await settle();
        expect(started).toEqual({ ok: true });

        latest().out('DO');
        latest().out('NE\r\n');
        latest().exit(0);
        expect(await action.done).toEqual({ ok: true });
    });

    it('fails with PowerShell\'s own first line when it dies before taking hold', async () => {
        const action = host.blockEnter(1000);
        latest().err('\r\nWindows refused the keyboard hook (error 5)\r\nAt line:1 char:1\r\n');
        latest().exit(2);
        const failure = { ok: false, error: 'Windows refused the keyboard hook (error 5)' };
        expect(await action.started).toEqual(failure);
        expect(await action.done).toEqual(failure);
    });

    it('kills a shim that never takes hold', async () => {
        const action = host.muteMicrophone(1000, KEYS);
        clock.advance(20_000);
        expect(latest().killed).toBe(true);
        latest().exit(null);
        expect(await action.done).toEqual({
            ok: false,
            error: 'PowerShell did not take hold of the microphone within 20 s',
        });
    });

    it('asks the shim to stop on release, and kills it if it will not', async () => {
        const action = host.blockEnter(300_000);
        latest().out('READY\n');
        action.release();
        expect(latest().written).toEqual(['stop\n']);
        expect(latest().stdinEnded).toBe(true);

        clock.advance(2999);
        expect(latest().killed).toBe(false);
        clock.advance(1);
        expect(latest().killed).toBe(true);
        latest().exit(null);
        // The keyboard hook dies with the process, so a kill is still a clean end.
        expect(await action.done).toEqual({ ok: true, detail: 'the shim was stopped' });
    });

    it('kills a shim that overruns its duration', () => {
        host.blockEnter(1000);
        latest().out('READY\n');
        clock.advance(1000 + 10_000);
        expect(latest().killed).toBe(true);
    });

    it('unmutes from outside when a mute shim is killed after muting', async () => {
        const action = host.muteMicrophone(30_000, NO_KEYS);
        const shim = latest();
        shim.out('MUTED {0.0.1.00000000}.{8f1c2a3b-0000-4000-8000-000000000001}\nREADY\n');
        clock.advance(30_000 + 10_000);
        expect(shim.killed).toBe(true);
        shim.exit(null);
        await settle();

        const unmute = latest();
        expect(unmute).not.toBe(shim);
        expect(unmute.script).toContain(
            "[Brobot.Shim]::Unmute([string[]]@('{0.0.1.00000000}.{8f1c2a3b-0000-4000-8000-000000000001}'), 0)",
        );
        unmute.out('DONE\n');
        unmute.exit(0);
        expect(await action.done).toEqual({
            ok: true,
            detail: 'the shim was stopped; the microphone was unmuted separately',
        });
    });

    it('says so when the microphone was already muted', async () => {
        const action = host.muteMicrophone(1000, NO_KEYS);
        latest().out('READY\nDONE\n');
        latest().exit(0);
        expect(await action.done).toEqual({
            ok: true,
            detail: 'the microphone was already muted, so it was left as it was',
        });
    });

    it('ignores a MUTED line that is not a device id', async () => {
        const action = host.muteMicrophone(1000, NO_KEYS);
        latest().out("MUTED x'); Remove-Item C:\\ -Recurse; ('\nREADY\n");
        latest().exit(1);
        await settle();
        // No unmute shim is run with that text quoted into it.
        expect(processes).toHaveLength(1);
        expect(await action.done).toEqual({ ok: false, error: 'PowerShell exited with code 1' });
    });

    describe('the voiceban overlay keys', () => {
        const F8 = { when: 'start', key: 'F8', ok: true } as const;
        const F9 = { when: 'end', key: 'F9', ok: true } as const;

        it('asks the shim for them as virtual-key codes', () => {
            host.muteMicrophone(30_000, KEYS);
            expect(latest().script).toContain('exit [Brobot.Shim]::MuteMicrophone(30000, 4242, 119, 120)');
            host.muteMicrophone(30_000, NO_KEYS);
            expect(latest().script).toContain('exit [Brobot.Shim]::MuteMicrophone(30000, 4242, 0, 0)');
        });

        it('reports the start key on started and the end key on done when the duration is over', async () => {
            const action = host.muteMicrophone(30_000, KEYS);
            latest().out(`MUTED ${DEVICE}\nPRESSED START\nREADY\n`);
            expect(await action.started).toEqual({ ok: true, keys: [F8] });
            latest().out('PRESSED END\nDONE\n');
            latest().exit(0);
            expect(await action.done).toEqual({ ok: true, keys: [F9] });
            expect(processes).toHaveLength(1);
        });

        it('reports the end key after Stop (release, and the app quitting)', async () => {
            const action = host.muteMicrophone(300_000, KEYS);
            latest().out(`MUTED ${DEVICE}\nPRESSED START\nREADY\n`);
            await action.started;
            action.release();
            expect(latest().written).toEqual(['stop\n']);
            latest().out('PRESSED END\nDONE\n');
            latest().exit(0);
            expect(await action.done).toEqual({ ok: true, keys: [F9] });
        });

        it('presses the end key from outside when the shim was killed before it could', async () => {
            const action = host.muteMicrophone(30_000, KEYS);
            const shim = latest();
            shim.out(`MUTED ${DEVICE}\nPRESSED START\nREADY\n`);
            clock.advance(30_000 + 10_000);
            expect(shim.killed).toBe(true);
            shim.exit(null);
            await settle();

            const restore = latest();
            expect(restore).not.toBe(shim);
            expect(restore.script).toContain(`[Brobot.Shim]::Unmute([string[]]@('${DEVICE}'), 120)`);
            restore.out('PRESSED END\nDONE\n');
            restore.exit(0);
            expect(await action.done).toEqual({
                ok: true,
                detail: 'the shim was stopped; the microphone was unmuted separately',
                keys: [F9],
            });
        });

        it('presses the end key from outside even when nothing needed unmuting', async () => {
            const action = host.muteMicrophone(300_000, KEYS);
            const shim = latest();
            shim.out('PRESSED START\nREADY\n');
            action.release();
            clock.advance(3000);
            expect(shim.killed).toBe(true);
            shim.exit(null);
            await settle();

            expect(latest().script).toContain('[Brobot.Shim]::Unmute([string[]]@(), 120)');
            latest().out('PRESSED END\nDONE\n');
            latest().exit(0);
            expect(await action.done).toEqual({ ok: true, detail: 'the shim was stopped', keys: [F9] });
        });

        it('does not press the end key twice when the shim pressed it before being killed', async () => {
            const action = host.muteMicrophone(30_000, KEYS);
            const shim = latest();
            shim.out(`MUTED ${DEVICE}\nPRESSED START\nREADY\nPRESSED END\n`);
            shim.exit(null);
            await settle();
            expect(latest().script).toContain(`Unmute([string[]]@('${DEVICE}'), 0)`);
            latest().out('DONE\n');
            latest().exit(0);
            expect((await action.done).keys).toEqual([F9]);
        });

        it('presses nothing from outside when the shim never got going', async () => {
            const action = host.muteMicrophone(30_000, KEYS);
            latest().err('No default recording device is set in Windows sound settings\n');
            latest().exit(3);
            expect(await action.done).toEqual({
                ok: false,
                error: 'No default recording device is set in Windows sound settings',
            });
            expect(processes).toHaveLength(1);
        });

        it('reports a key press Windows refused, and still mutes', async () => {
            const action = host.muteMicrophone(30_000, KEYS);
            latest().out(`MUTED ${DEVICE}\nNOT PRESSED START Windows refused the key press (error 5)\nREADY\n`);
            expect(await action.started).toEqual({
                ok: true,
                keys: [{ when: 'start', key: 'F8', ok: false, error: 'Windows refused the key press (error 5)' }],
            });
        });

        it('ignores press lines for a key it did not ask for', async () => {
            const action = host.muteMicrophone(30_000, { start: 'none', end: 'F9' });
            latest().out('PRESSED START\nPRESSED SIDEWAYS\nREADY\n');
            expect(await action.started).toEqual({ ok: true });
        });
    });

    describe('a single key press (the Test button for a voiceban key)', () => {
        it('runs the unmute shim with no devices, which only presses the combination', async () => {
            const pressed = host.pressKey('Ctrl+Alt+F8');
            expect(latest().script.split('\n').at(-1)).toBe('exit [Brobot.Shim]::Unmute([string[]]@(), 887)');
            latest().out('PRESSED END\nDONE\n');
            latest().exit(0);
            expect(await pressed).toEqual({ ok: true });
        });

        it('says why Windows refused it', async () => {
            const pressed = host.pressKey('F8');
            latest().out('NOT PRESSED END Windows refused the key press (error 5)\nDONE\n');
            latest().exit(0);
            expect(await pressed).toEqual({ ok: false, error: 'Windows refused the key press (error 5)' });
        });

        it('fails when PowerShell did', async () => {
            const pressed = host.pressKey('F8');
            latest().err('Add-Type : Cannot add type.\n');
            latest().exit(1);
            expect(await pressed).toEqual({ ok: false, error: 'Add-Type : Cannot add type.' });
        });
    });

    it('fails cleanly when PowerShell cannot be spawned', async () => {
        const broken = new WindowsHostControl({
            clock,
            parentPid: 1,
            spawn: () => {
                throw new Error('spawn powershell.exe ENOENT');
            },
        });
        const action = broken.blockEnter(1000);
        expect(await action.done).toEqual({
            ok: false,
            error: 'Could not start PowerShell: spawn powershell.exe ENOENT',
        });
    });
});
