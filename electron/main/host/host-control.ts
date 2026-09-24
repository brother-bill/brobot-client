/**
 * Everything brobot may do to the streamer's machine, behind one interface.
 *
 * Two implementations: `WindowsHostControl`, which really blocks the Enter key
 * and mutes the microphone, and `DryRunHostControl`, which only says it did —
 * used by the specs, in safe mode, and on any OS that is not Windows. The
 * command runner cannot tell them apart, which is the point: what the window
 * shows in safe mode is exactly what would have happened.
 *
 * Later host features (OBS, the overlay — migration plan §1.3) are new methods
 * here, not new code paths around it.
 */

export type HostActionKind = 'block-enter' | 'mute-microphone';

export type HostActionResult =
    | { readonly ok: true; readonly detail?: string }
    | { readonly ok: false; readonly error: string };

/** One action in progress. */
export interface HostAction {
    /**
     * Resolves once the machine is back to normal — the duration elapsed, or
     * {@link release} was called — or the action failed. Never rejects.
     */
    readonly done: Promise<HostActionResult>;
    /**
     * Resolves once the action has actually taken hold (the keyboard hook is
     * installed, the mic is muted), or with the failure that stopped it.
     * Never rejects.
     */
    readonly started: Promise<HostActionResult>;
    /** End now: unblock, unmute. Idempotent; `done` still resolves. */
    release(): void;
}

export interface HostControl {
    readonly kind: 'windows' | 'dry-run';
    /**
     * Swallow Enter (both Enter keys) for `durationMs`, system-wide, so the
     * streamer cannot send a chat message. Key-up is passed through, so a key
     * held down when the block starts cannot get stuck.
     */
    blockEnter(durationMs: number): HostAction;
    /**
     * Mute the default recording device(s) for `durationMs`, then restore
     * whatever mute state they had before.
     */
    muteMicrophone(durationMs: number): HostAction;
}
