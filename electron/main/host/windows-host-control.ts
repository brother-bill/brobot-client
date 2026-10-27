/**
 * HostControl for Windows: each action is one `powershell.exe` running the
 * shim in `powershell-shim.ts`. See that file for why it is PowerShell and not
 * nut.js, and how an action is guaranteed to end.
 *
 * The process is injected ({@link ShimSpawner}) so the protocol handling below
 * — READY, MUTED, PRESSED, DONE, exit codes, timeouts, the unmute fallback — is covered
 * by `windows-host-control.spec.ts` on any OS.
 */

import type { OverlayKeySetting, VoicebanKeys } from '@brobot-client/shared';
import type { Clock } from '../core/clock';
import type { HostAction, HostActionResult, HostControl, KeyPress } from './host-control';
import {
    SHIM_DONE,
    SHIM_MUTED_PREFIX,
    SHIM_NOT_PRESSED_PREFIX,
    SHIM_PRESSED_PREFIX,
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

const NO_KEYS: VoicebanKeys = { start: 'none', end: 'none' };

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
        return this.run(blockEnterScript(durationMs, this.options.parentPid), durationMs, 'keyboard', NO_KEYS);
    }

    muteMicrophone(durationMs: number, keys: VoicebanKeys): HostAction {
        const script = muteMicrophoneScript(durationMs, this.options.parentPid, keys);
        return this.run(script, durationMs, 'microphone', keys);
    }

    private run(script: string, durationMs: number, what: 'keyboard' | 'microphone', keys: VoicebanKeys): HostAction {
        const { clock } = this.options;
        let resolveStarted: (result: HostActionResult) => void = () => undefined;
        let resolveDone: (result: HostActionResult) => void = () => undefined;
        const started = new Promise<HostActionResult>(resolve => (resolveStarted = resolve));
        const done = new Promise<HostActionResult>(resolve => (resolveDone = resolve));

        let ready = false;
        let finished = false;
        let reportedDone = false;
        let killedByUs = false;
        let stderrText = '';
        const mutedIds: string[] = [];
        // Overlay keys the shim reported: START ones go on `started`, END ones on `done`.
        const startKeys: KeyPress[] = [];
        const endKeys: KeyPress[] = [];
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
            if (!ready) {
                resolveStarted(withKeys(result.ok ? { ok: false, error: 'stopped before it started' } : result, startKeys));
            }
            resolveDone(withKeys(result, endKeys));
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
                resolveStarted(withKeys({ ok: true }, startKeys));
                // A shim that never says DONE is killed a little after it should have.
                overrunTimer = clock.setTimeout(kill, durationMs + this.overrunMs);
            } else if (line === SHIM_DONE) {
                reportedDone = true;
            } else if (line.startsWith(SHIM_MUTED_PREFIX)) {
                const id = line.slice(SHIM_MUTED_PREFIX.length).trim();
                if (isDeviceId(id)) mutedIds.push(id);
            } else {
                const press = keyPressOf(line, keys);
                if (press !== null) (press.when === 'start' ? startKeys : endKeys).push(press);
            }
        };

        onLines(child, onLine);
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
            const exited = firstLine(stderrText) ?? `PowerShell exited with code ${code ?? 'none'}`;
            // It ended without undoing its work: killed by us after an overrun
            // or a release that was not honoured, or by something else. The
            // keyboard hook died with the process; a muted microphone and the
            // overlay did not, so put them back from here. The end key is
            // owed once the ban took hold (or its start key was pressed) and
            // the shim had not pressed it yet.
            const owedKey: OverlayKeySetting =
                endKeys.length === 0 && (ready || startKeys.length > 0) ? keys.end : 'none';
            if (mutedIds.length > 0 || owedKey !== 'none') {
                void this.restore(mutedIds, owedKey).then(restored => {
                    endKeys.push(...(restored.keys ?? []));
                    if (!ready) {
                        finish({ ok: false, error: exited });
                    } else if (!restored.ok) {
                        finish({
                            ok: false,
                            error:
                                mutedIds.length > 0
                                    ? `The microphone may still be muted: ${restored.error}`
                                    : `Could not press ${owedKey}: ${restored.error}`,
                        });
                    } else if (mutedIds.length > 0) {
                        finish({ ok: true, detail: 'the shim was stopped; the microphone was unmuted separately' });
                    } else {
                        finish(killedByUs ? { ok: true, detail: 'the shim was stopped' } : { ok: false, error: exited });
                    }
                });
                return;
            }
            finish(ready && killedByUs ? { ok: true, detail: 'the shim was stopped' } : { ok: false, error: exited });
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

    /**
     * Runs the unmute shim for devices a killed mute shim left muted, and
     * presses the overlay's end key it did not get to.
     */
    private restore(ids: readonly string[], endKey: OverlayKeySetting): Promise<HostActionResult> {
        return new Promise(resolve => {
            let stderrText = '';
            const pressed: KeyPress[] = [];
            let child: ShimProcess;
            try {
                child = this.options.spawn(POWERSHELL, powershellArgs(unmuteScript(ids, endKey)));
            } catch (error) {
                resolve({ ok: false, error: messageOf(error) });
                return;
            }
            onLines(child, line => {
                const press = keyPressOf(line, { start: 'none', end: endKey });
                if (press !== null) pressed.push(press);
            });
            child.stderr?.on('data', chunk => {
                if (stderrText.length < 4000) stderrText += chunk.toString();
            });
            child.on('error', error => resolve({ ok: false, error: error.message }));
            child.on('exit', code =>
                resolve(
                    withKeys(
                        code === 0
                            ? { ok: true }
                            : { ok: false, error: firstLine(stderrText) ?? `PowerShell exited with code ${code ?? 'none'}` },
                        pressed,
                    ),
                ),
            );
        });
    }
}

/** Calls `onLine` with each whole, trimmed line the shim prints. */
function onLines(child: ShimProcess, onLine: (line: string) => void): void {
    let buffer = '';
    child.stdout?.on('data', chunk => {
        buffer += chunk.toString();
        let newline = buffer.indexOf('\n');
        while (newline !== -1) {
            onLine(buffer.slice(0, newline).trim());
            buffer = buffer.slice(newline + 1);
            newline = buffer.indexOf('\n');
        }
    });
}

/** `PRESSED END`, `NOT PRESSED START <why>` → the key press it reports, or null. */
function keyPressOf(line: string, keys: VoicebanKeys): KeyPress | null {
    const pressed = line.startsWith(SHIM_PRESSED_PREFIX);
    const rest = pressed
        ? line.slice(SHIM_PRESSED_PREFIX.length)
        : line.startsWith(SHIM_NOT_PRESSED_PREFIX)
          ? line.slice(SHIM_NOT_PRESSED_PREFIX.length)
          : null;
    if (rest === null) return null;
    const [phase = '', ...why] = rest.split(' ');
    const when = phase === 'START' ? 'start' : phase === 'END' ? 'end' : null;
    if (when === null) return null;
    const key = keys[when];
    if (key === 'none') return null;
    return pressed
        ? { when, key, ok: true }
        : { when, key, ok: false, error: why.join(' ').trim() || 'Windows refused the key press' };
}

/** The result with `keys` attached, or as it was when there are none. */
function withKeys(result: HostActionResult, keys: readonly KeyPress[]): HostActionResult {
    return keys.length === 0 ? result : { ...result, keys: [...keys] };
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
