/**
 * HostControl for Windows: each action is one `powershell.exe` running the
 * shim in `powershell-shim.ts`. See that file for why it is PowerShell and not
 * nut.js, and how an action is guaranteed to end.
 *
 * The process is injected ({@link ShimSpawner}) so the protocol handling below
 * — READY, MUTED, DONE, exit codes, timeouts, the unmute fallback — is covered
 * by `windows-host-control.spec.ts` on any OS.
 */

import type { Clock } from '../core/clock';
import type { HostAction, HostActionResult, HostControl } from './host-control';
import {
    SHIM_DONE,
    SHIM_MUTED_PREFIX,
    SHIM_READY,
    blockEnterScript,
    isDeviceId,
    muteMicrophoneScript,
    powershellArgs,
    unmuteScript,
} from './powershell-shim';

/** The slice of `ChildProcess` this file uses. */
export interface ShimProcess {
    readonly stdout: { on(event: 'data', listener: (chunk: { toString(): string }) => void): unknown } | null;
    readonly stderr: { on(event: 'data', listener: (chunk: { toString(): string }) => void): unknown } | null;
    readonly stdin: { write(data: string): unknown; end(): unknown } | null;
    on(event: 'exit', listener: (code: number | null, signal: string | null) => void): unknown;
    on(event: 'error', listener: (error: Error) => void): unknown;
    kill(): unknown;
}

export type ShimSpawner = (command: string, args: readonly string[]) => ShimProcess;

export interface WindowsHostControlOptions {
    readonly spawn: ShimSpawner;
    readonly clock: Clock;
    /** This process's pid; the shim ends its action when it disappears. */
    readonly parentPid: number;
    /**
     * How long PowerShell may take to compile the shim and take hold. Add-Type
     * runs the C# compiler, which is a second or two on a cold machine.
     */
    readonly startTimeoutMs?: number;
    /** After `release()`, how long the shim gets to undo its work before it is killed. */
    readonly stopGraceMs?: number;
    /** Extra time past the duration before a shim that has not finished is killed. */
    readonly overrunMs?: number;
}

export const POWERSHELL = 'powershell.exe';

export class WindowsHostControl implements HostControl {
    readonly kind = 'windows' as const;

    private readonly startTimeoutMs: number;
    private readonly stopGraceMs: number;
    private readonly overrunMs: number;

    constructor(private readonly options: WindowsHostControlOptions) {
        this.startTimeoutMs = options.startTimeoutMs ?? 20_000;
        this.stopGraceMs = options.stopGraceMs ?? 3000;
        this.overrunMs = options.overrunMs ?? 10_000;
    }

    blockEnter(durationMs: number): HostAction {
        return this.run(blockEnterScript(durationMs, this.options.parentPid), durationMs, 'keyboard');
    }

    muteMicrophone(durationMs: number): HostAction {
        return this.run(muteMicrophoneScript(durationMs, this.options.parentPid), durationMs, 'microphone');
    }

    private run(script: string, durationMs: number, what: 'keyboard' | 'microphone'): HostAction {
        const { clock } = this.options;
        let resolveStarted: (result: HostActionResult) => void = () => undefined;
        let resolveDone: (result: HostActionResult) => void = () => undefined;
        const started = new Promise<HostActionResult>(resolve => (resolveStarted = resolve));
        const done = new Promise<HostActionResult>(resolve => (resolveDone = resolve));

        let ready = false;
        let finished = false;
        let reportedDone = false;
        let killedByUs = false;
        let stdoutBuffer = '';
        let stderrText = '';
        const mutedIds: string[] = [];
        let startTimer: unknown = null;
        let overrunTimer: unknown = null;
        let graceTimer: unknown = null;

        const clear = (): void => {
            for (const timer of [startTimer, overrunTimer, graceTimer]) {
                if (timer !== null) clock.clearTimeout(timer);
            }
            startTimer = overrunTimer = graceTimer = null;
        };

        const finish = (result: HostActionResult): void => {
            if (finished) return;
            finished = true;
            clear();
            if (!ready) resolveStarted(result.ok ? { ok: false, error: 'stopped before it started' } : result);
            resolveDone(result);
        };

        let child: ShimProcess;
        try {
            child = this.options.spawn(POWERSHELL, powershellArgs(script));
        } catch (error) {
            const failure = { ok: false as const, error: `Could not start PowerShell: ${messageOf(error)}` };
            return { started: Promise.resolve(failure), done: Promise.resolve(failure), release: () => undefined };
        }

        const kill = (): void => {
            killedByUs = true;
            try {
                child.kill();
            } catch {
                // Already gone.
            }
        };

        const onLine = (line: string): void => {
            if (line === SHIM_READY) {
                ready = true;
                if (startTimer !== null) clock.clearTimeout(startTimer);
                startTimer = null;
                resolveStarted({ ok: true });
                // A shim that never says DONE is killed a little after it should have.
                overrunTimer = clock.setTimeout(kill, durationMs + this.overrunMs);
            } else if (line === SHIM_DONE) {
                reportedDone = true;
            } else if (line.startsWith(SHIM_MUTED_PREFIX)) {
                const id = line.slice(SHIM_MUTED_PREFIX.length).trim();
                if (isDeviceId(id)) mutedIds.push(id);
            }
        };

        child.stdout?.on('data', chunk => {
            stdoutBuffer += chunk.toString();
            let newline = stdoutBuffer.indexOf('\n');
            while (newline !== -1) {
                onLine(stdoutBuffer.slice(0, newline).trim());
                stdoutBuffer = stdoutBuffer.slice(newline + 1);
                newline = stdoutBuffer.indexOf('\n');
            }
        });
        child.stderr?.on('data', chunk => {
            // Bounded: PowerShell error records can be long, and only the
            // first lines say what went wrong.
            if (stderrText.length < 4000) stderrText += chunk.toString();
        });
        child.on('error', error => {
            finish({ ok: false, error: `Could not start PowerShell: ${error.message}` });
        });
        child.on('exit', code => {
            if (code === 0 && reportedDone) {
                const detail =
                    what === 'microphone' && mutedIds.length === 0
                        ? 'the microphone was already muted, so it was left as it was'
                        : undefined;
                finish(detail === undefined ? { ok: true } : { ok: true, detail });
                return;
            }
            if (!ready) {
                finish({ ok: false, error: firstLine(stderrText) ?? `PowerShell exited with code ${code ?? 'none'}` });
                return;
            }
            // It took hold and then ended without undoing its work: killed by
            // us after an overrun or a release that was not honoured, or by
            // something else. The keyboard hook died with the process; the
            // microphone did not, so put it back from here.
            if (what === 'microphone' && mutedIds.length > 0) {
                void this.unmute(mutedIds).then(restored =>
                    finish(
                        restored.ok
                            ? { ok: true, detail: 'the shim was stopped; the microphone was unmuted separately' }
                            : { ok: false, error: `The microphone may still be muted: ${restored.error}` },
                    ),
                );
                return;
            }
            finish(
                killedByUs
                    ? { ok: true, detail: 'the shim was stopped' }
                    : { ok: false, error: firstLine(stderrText) ?? `PowerShell exited with code ${code ?? 'none'}` },
            );
        });

        startTimer = clock.setTimeout(() => {
            startTimer = null;
            if (ready || finished) return;
            stderrText ||= `PowerShell did not take hold of the ${what} within ${Math.round(this.startTimeoutMs / 1000)} s`;
            kill();
        }, this.startTimeoutMs);

        return {
            started,
            done,
            release: () => {
                if (finished || graceTimer !== null) return;
                try {
                    child.stdin?.write('stop\n');
                    child.stdin?.end();
                } catch {
                    // A closed stdin is a stop signal too.
                }
                graceTimer = clock.setTimeout(kill, this.stopGraceMs);
            },
        };
    }

    /** Runs the unmute shim for devices a killed mute shim left muted. */
    private unmute(ids: readonly string[]): Promise<HostActionResult> {
        return new Promise(resolve => {
            let stderrText = '';
            let child: ShimProcess;
            try {
                child = this.options.spawn(POWERSHELL, powershellArgs(unmuteScript(ids)));
            } catch (error) {
                resolve({ ok: false, error: messageOf(error) });
                return;
            }
            child.stderr?.on('data', chunk => {
                if (stderrText.length < 4000) stderrText += chunk.toString();
            });
            child.on('error', error => resolve({ ok: false, error: error.message }));
            child.on('exit', code =>
                resolve(
                    code === 0
                        ? { ok: true }
                        : { ok: false, error: firstLine(stderrText) ?? `PowerShell exited with code ${code ?? 'none'}` },
                ),
            );
        });
    }
}

function firstLine(text: string): string | null {
    const line = text
        .split(/\r?\n/)
        .map(l => l.trim())
        .find(l => l !== '');
    return line ?? null;
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
