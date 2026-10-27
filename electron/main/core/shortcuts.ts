/**
 * The streamer's shortcuts — Marker, Prediction, Ad — from the key press to
 * brobot's answer: registering each combination with Windows (and saying so
 * loudly when another app already has it), the 5 s de-dupe the pre-rewrite
 * client had, the `create_marker` / `create_prediction` / `play_ad` frame,
 * and the `<hotkey>_complete` reply in the log and as a notification.
 *
 * No Electron: Electron's `globalShortcut` arrives as {@link GlobalShortcuts}
 * (wired in `main.ts`), so `shortcuts.spec.ts` can refuse a registration the
 * way Windows does when another app owns the combination.
 */

import {
    BINDING_LABEL,
    CAPTURE_TIMEOUT_MS,
    HOTKEY_REPEAT_MS,
    STREAMER_HOTKEYS,
    describeCombo,
    type HotkeyCompleteEvent,
    type HotkeyEvent,
    type KeyCombo,
    type KeyComboSetting,
    type LogSource,
    type LogTone,
    type ShortcutState,
    type ShortcutStatus,
    type StreamerHotkey,
} from '@brobot-client/shared';
import type { Clock, TimerHandle } from './clock';

/** System-wide shortcuts: Electron's `globalShortcut` in the app. */
export interface GlobalShortcuts {
    /** False when Windows refused it: another app already has the combination. */
    register(combo: KeyCombo, onPress: () => void): boolean;
    unregister(combo: KeyCombo): void;
}

export interface ShortcutOptions {
    readonly clock: Clock;
    readonly shortcuts: GlobalShortcuts;
    /** Sends the frame to brobot; false when there is no connection to send it on. */
    readonly send: (event: HotkeyEvent) => boolean;
    /** Safe mode: log what would have been sent, send nothing. */
    readonly safeMode: () => boolean;
    readonly log: (source: LogSource, tone: LogTone, message: string) => void;
    /** A Windows notification: the streamer is usually in a game, not looking at the window. */
    readonly notify: (title: string, body: string) => void;
    /** A shortcut's status changed. */
    readonly onChange: () => void;
}

/**
 * A second press of the same shortcut inside this long is dropped, as the
 * pre-rewrite client did; brobot refuses one too.
 */
export const SHORTCUT_REPEAT_MS = HOTKEY_REPEAT_MS;

/** How long brobot gets to answer before the log says it did not. */
export const SHORTCUT_REPLY_TIMEOUT_MS = 15_000;

const COPY: Readonly<Record<StreamerHotkey, { what: string; done: string; failed: string }>> = {
    create_marker: { what: 'a stream marker', done: 'Stream marker created', failed: 'No stream marker' },
    create_prediction: { what: 'the prediction', done: 'Prediction started', failed: 'No prediction' },
    play_ad: { what: 'an ad break', done: 'Ad break started', failed: 'No ad break' },
};

const NO_BINDINGS: Readonly<Record<StreamerHotkey, KeyComboSetting>> = {
    create_marker: 'none',
    create_prediction: 'none',
    play_ad: 'none',
};

export class ShortcutManager {
    private bindings: Readonly<Record<StreamerHotkey, KeyComboSetting>> = NO_BINDINGS;
    /** What is registered with Windows right now, per shortcut. */
    private readonly registered = new Map<StreamerHotkey, KeyCombo>();
    private readonly states = new Map<StreamerHotkey, ShortcutState>();
    /** The combination last reported as taken by another app, per shortcut. */
    private readonly reportedTaken = new Map<StreamerHotkey, KeyCombo>();
    private suspended = false;
    private captureTimer: TimerHandle | null = null;
    private readonly lastPressedAt = new Map<StreamerHotkey, number>();
    private readonly replyTimers = new Map<StreamerHotkey, TimerHandle>();

    constructor(private readonly options: ShortcutOptions) {}

    get status(): Readonly<Record<StreamerHotkey, ShortcutStatus>> {
        const status = (hotkey: StreamerHotkey): ShortcutStatus => ({
            state: this.states.get(hotkey) ?? 'off',
            combo: this.bindings[hotkey],
        });
        return {
            create_marker: status('create_marker'),
            create_prediction: status('create_prediction'),
            play_ad: status('play_ad'),
        };
    }

    /**
     * Listen for these combinations. Called at start and on every settings
     * save: unchanged ones are left alone, and one another app had is tried
     * again (it may have let go since).
     */
    apply(bindings: Readonly<Record<StreamerHotkey, KeyComboSetting>>): void {
        this.bindings = { ...bindings };
        this.sync();
    }

    /**
     * `true` lets go of every shortcut while the window waits for a new
     * combination — a registered one never reaches the window, it fires — and
     * `false` takes them back. A capture left hanging ends by itself.
     */
    suspend(active: boolean): void {
        if (this.captureTimer !== null) this.options.clock.clearTimeout(this.captureTimer);
        this.captureTimer = null;
        if (active) {
            this.captureTimer = this.options.clock.setTimeout(() => {
                this.captureTimer = null;
                this.options.log('app', 'info', 'Shortcuts are listening again (the key change was not finished)');
                this.suspend(false);
            }, CAPTURE_TIMEOUT_MS);
        }
        if (this.suspended === active) return;
        this.suspended = active;
        this.sync();
    }

    /**
     * Why Windows would not give `combo` to `hotkey`, or null when it would.
     * Tried for real (registered, then let go), because only Windows knows
     * which combinations other apps hold.
     */
    probe(hotkey: StreamerHotkey, combo: KeyComboSetting): string | null {
        if (combo === 'none' || [...this.registered.values()].includes(combo)) return null;
        const { shortcuts } = this.options;
        if (!shortcuts.register(combo, () => undefined)) {
            return (
                `Another app already uses ${describeCombo(combo)} as a shortcut, so Windows will not let brobot ` +
                `listen for it. The ${BINDING_LABEL[hotkey]} shortcut will not work until that app lets go of it.`
            );
        }
        shortcuts.unregister(combo);
        return null;
    }

    /** The shortcut was pressed (`test`: the window's Test button). */
    press(hotkey: StreamerHotkey, test = false): void {
        const { clock, log, notify } = this.options;
        const label = BINDING_LABEL[hotkey];
        const copy = COPY[hotkey];
        const prefix = test ? 'Test: ' : '';
        const now = clock.now();
        const last = this.lastPressedAt.get(hotkey);
        if (last !== undefined && now - last < SHORTCUT_REPEAT_MS) {
            log('app', 'info', `${prefix}${label} pressed again within ${SHORTCUT_REPEAT_MS / 1000} s; ignored`);
            return;
        }
        this.lastPressedAt.set(hotkey, now);

        if (this.options.safeMode()) {
            log('app', 'info', `${prefix}Would ask brobot for ${copy.what} (safe mode: nothing was sent)`);
            notify(`${label}: not sent`, 'Safe mode is on, so brobot sent nothing to Twitch.');
            return;
        }
        if (!this.options.send({ type: hotkey })) {
            log('connection', 'warning', `${prefix}${label} not sent: brobot is not connected`);
            notify(`${label}: not sent`, 'brobot is not connected, so nothing reached Twitch.');
            return;
        }
        log('app', 'info', `${prefix}Asked brobot for ${copy.what}`);
        const waiting = this.replyTimers.get(hotkey);
        if (waiting !== undefined) clock.clearTimeout(waiting);
        this.replyTimers.set(
            hotkey,
            clock.setTimeout(() => {
                this.replyTimers.delete(hotkey);
                log('bot', 'warning', `brobot did not answer about the ${label.toLowerCase()} within ${SHORTCUT_REPLY_TIMEOUT_MS / 1000} s`);
            }, SHORTCUT_REPLY_TIMEOUT_MS),
        );
    }

    /** brobot's answer: done, or why not. */
    complete(event: HotkeyCompleteEvent): void {
        const hotkey = event.type.slice(0, -'_complete'.length) as StreamerHotkey;
        const copy = COPY[hotkey];
        const waiting = this.replyTimers.get(hotkey);
        if (waiting !== undefined) this.options.clock.clearTimeout(waiting);
        this.replyTimers.delete(hotkey);
        if (event.error === undefined) {
            this.options.log('bot', 'success', copy.done);
            this.options.notify(copy.done, 'brobot says Twitch did it.');
        } else {
            this.options.log('bot', 'error', `${copy.failed}: ${event.error}`);
            this.options.notify(copy.failed, event.error);
        }
    }

    /** Let go of everything. Called on quit. */
    stop(): void {
        for (const combo of this.registered.values()) this.options.shortcuts.unregister(combo);
        this.registered.clear();
        for (const timer of this.replyTimers.values()) this.options.clock.clearTimeout(timer);
        this.replyTimers.clear();
        if (this.captureTimer !== null) this.options.clock.clearTimeout(this.captureTimer);
        this.captureTimer = null;
    }

    private sync(): void {
        // Let go of everything that changes before taking anything new, so two
        // shortcuts swapping combinations do not trip over each other.
        for (const hotkey of STREAMER_HOTKEYS) {
            const have = this.registered.get(hotkey);
            const want = this.suspended ? 'none' : this.bindings[hotkey];
            if (have !== undefined && have !== want) {
                this.options.shortcuts.unregister(have);
                this.registered.delete(hotkey);
            }
        }
        let changed = false;
        for (const hotkey of STREAMER_HOTKEYS) {
            const before = this.states.get(hotkey) ?? 'off';
            const state = this.syncOne(hotkey);
            this.states.set(hotkey, state);
            if (state !== before) changed = true;
        }
        if (changed) this.options.onChange();
    }

    private syncOne(hotkey: StreamerHotkey): ShortcutState {
        const { shortcuts, log, notify } = this.options;
        const combo = this.bindings[hotkey];
        const want = this.suspended ? 'none' : combo;
        const have = this.registered.get(hotkey);
        if (have === want) return 'active';
        if (want === 'none') {
            if (!this.suspended) this.reportedTaken.delete(hotkey);
            return this.suspended && combo !== 'none' ? 'paused' : 'off';
        }

        const label = BINDING_LABEL[hotkey];
        const shown = describeCombo(want);
        if (shortcuts.register(want, () => this.press(hotkey))) {
            this.registered.set(hotkey, want);
            if (this.reportedTaken.delete(hotkey)) log('app', 'success', `The ${label} shortcut ${shown} is working now`);
            return 'active';
        }
        // Said once per combination, not again on every settings save or key
        // change while it lasts.
        if (this.reportedTaken.get(hotkey) !== want) {
            this.reportedTaken.set(hotkey, want);
            log(
                'app',
                'error',
                `The ${label} shortcut ${shown} is not working: another app already uses it. ` +
                    'Pick another under Settings → Key bindings.',
            );
            notify(`${label} shortcut not working`, `Another app already uses ${shown}. Pick another in brobot → Settings → Key bindings.`);
        }
        return 'taken';
    }
}
