import { beforeEach, describe, expect, it } from 'vitest';
import { FakeClock, settle } from '../testing/fake-clock';
import type { HostActionResult } from './host-control';
import { POWERSHELL, WindowsHostControl, type ShimProcess } from './windows-host-control';

type Listener = (...args: never[]) => void;

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
        const action = host.muteMicrophone(1000);
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
        const action = host.muteMicrophone(30_000);
        const shim = latest();
        shim.out('MUTED {0.0.1.00000000}.{8f1c2a3b-0000-4000-8000-000000000001}\nREADY\n');
        clock.advance(30_000 + 10_000);
        expect(shim.killed).toBe(true);
        shim.exit(null);
        await settle();

        const unmute = latest();
        expect(unmute).not.toBe(shim);
        expect(unmute.script).toContain(
            "[Brobot.Shim]::Unmute([string[]]@('{0.0.1.00000000}.{8f1c2a3b-0000-4000-8000-000000000001}'))",
        );
        unmute.out('DONE\n');
        unmute.exit(0);
        expect(await action.done).toEqual({
            ok: true,
            detail: 'the shim was stopped; the microphone was unmuted separately',
        });
    });

    it('says so when the microphone was already muted', async () => {
        const action = host.muteMicrophone(1000);
        latest().out('READY\nDONE\n');
        latest().exit(0);
        expect(await action.done).toEqual({
            ok: true,
            detail: 'the microphone was already muted, so it was left as it was',
        });
    });

    it('ignores a MUTED line that is not a device id', async () => {
        const action = host.muteMicrophone(1000);
        latest().out("MUTED x'); Remove-Item C:\\ -Recurse; ('\nREADY\n");
        latest().exit(1);
        await settle();
        // No unmute shim is run with that text quoted into it.
        expect(processes).toHaveLength(1);
        expect(await action.done).toEqual({ ok: false, error: 'PowerShell exited with code 1' });
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
