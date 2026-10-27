/**
 * The app's one stateful object: settings, the connection, the command
 * runner, the host driver in use, and the log — and the snapshot the window
 * and the tray are drawn from.
 *
 * Everything that touches Electron or the OS (the settings file, `safeStorage`,
 * login items, the real socket, PowerShell) is passed in, so the whole flow —
 * a ban arriving over a socket, the host acting, the reply going back — runs in
 * `controller.spec.ts` against fakes.
 */

import {
    BINDING_LABEL,
    INITIAL_CONNECTION_STATUS,
    KEY_BINDING_IDS,
    bindingsError,
    checkBinding,
    describeCombo,
    isPressedBinding,
    normalizeServerUrl,
    voicebanKeysOf,
    type ActiveBan,
    type BanCommand,
    type BindingCheck,
    type ClientSnapshot,
    type ConnectionStatus,
    type HostInfo,
    type KeyBindingId,
    type KeyBindings,
    type KeyComboSetting,
    type LogEntry,
    type LogSource,
    type LogTone,
    type SettingsPatch,
} from '@brobot-client/shared';
import { DryRunHostControl } from '../host/dry-run-host-control';
import type { HostControl } from '../host/host-control';
import type { Clock } from './clock';
import { CommandRunner } from './command-runner';
import { ConnectionManager, type SocketFactory } from './connection';
import { EventLog } from './event-log';
import { chatRelayLine, NO_HORROR_RUN, relayLine, type GameRelay, type HorrorRun } from './game-relay';
import type { StoredSettings } from './settings-file';
import { ShortcutManager, type GlobalShortcuts } from './shortcuts';

/** Persistence, implemented over a JSON file + `safeStorage` in `services/settings-store.ts`. */
export interface SettingsStore {
    readonly secureStorageAvailable: boolean;
    load(): StoredSettings;
    save(settings: StoredSettings): void;
    readSecret(): string | null;
    /** `null` forgets it. Throws when secure storage is unavailable. */
    writeSecret(secret: string | null): void;
}

/** Windows sign-in launch; a no-op outside an installed build. */
export interface LoginItems {
    /** False in development, where it would register `electron.exe` itself. */
    readonly supported: boolean;
    set(enabled: boolean): void;
}

export interface ControllerOptions {
    readonly clock: Clock;
    readonly store: SettingsStore;
    readonly socketFactory: SocketFactory;
    /** The real driver, or null where there is none (not Windows). */
    readonly windowsHost: HostControl | null;
    readonly platform: string;
    readonly loginItems: LoginItems;
    readonly version: string;
    readonly emitSnapshot: (snapshot: ClientSnapshot) => void;
    readonly emitLog: (entry: LogEntry) => void;
    /** Development overrides (`BROBOT_SERVER_URL`, `BROBOT_WS_SECRET`); never persisted. */
    readonly override?: { readonly serverUrl?: string; readonly secret?: string };
    readonly random?: () => number;
    /** The horror game's local relay (SLEEP TIGHT); without one, horror redemptions are only logged. */
    readonly gameRelay?: GameRelay;
    /** System-wide shortcuts for Marker / Prediction / Ad (Electron's `globalShortcut`). */
    readonly shortcuts: GlobalShortcuts;
    /** A Windows notification, for what the streamer should know while in a game. */
    readonly notify?: (title: string, body: string) => void;
}

export class ClientController {
    private settings: StoredSettings;
    private connectionStatus: ConnectionStatus = INITIAL_CONNECTION_STATUS;
    /** What the horror game last said about its run (SLEEP TIGHT). */
    private horrorRun: HorrorRun = NO_HORROR_RUN;
    /** Whether the last forwarded chat line reached the game (logs once per stretch, not per line). */
    private chatForwarding = false;
    private activeBans: readonly ActiveBan[] = [];
    private readonly log: EventLog;
    private readonly connection: ConnectionManager;
    private readonly runner: CommandRunner;
    private readonly shortcuts: ShortcutManager;
    private readonly dryRun: DryRunHostControl;
    private readonly listeners = new Set<(snapshot: ClientSnapshot) => void>();

    constructor(private readonly options: ControllerOptions) {
        this.settings = options.store.load();
        this.dryRun = new DryRunHostControl(options.clock);
        this.log = new EventLog(options.clock, entry => options.emitLog(entry));
        this.connection = new ConnectionManager({
            factory: options.socketFactory,
            clock: options.clock,
            random: options.random,
            onStatus: status => {
                const opened = status.state === 'connected' && this.connectionStatus.state !== 'connected';
                this.connectionStatus = status;
                // brobot (re)connected during a horror run: tell it (it hides the rewards by default)
                if (opened && this.horrorRun.live) this.sendHorrorRun();
                this.changed();
            },
            onBan: event => void this.runner.handle(event),
            onHorror: event => {
                const what = `"${event.effect}"${event.user ? ` from ${event.user}` : ''}`;
                if (!options.gameRelay) {
                    this.log.append('bot', 'info', `Horror redemption ${what} (no game relay here)`);
                    return;
                }
                options.gameRelay.send(relayLine(event), delivered =>
                    this.log.append('bot', delivered ? 'success' : 'warning', delivered ? `Sent ${what} to the horror game` : `Horror redemption ${what}: the game is not running`),
                );
            },
            onHorrorChat: event => {
                // brobot's SLEEP TIGHT rehearsal / live: a chat line for the game (dropped while the game is not running)
                const delivered = options.gameRelay?.sendIfConnected?.(chatRelayLine(event)) ?? false;
                if (delivered && !this.chatForwarding) this.log.append('bot', 'info', 'Passing Twitch chat on to the horror game');
                this.chatForwarding = delivered;
            },
            onHotkeyComplete: event => this.shortcuts.complete(event),
            onLog: (tone, message) => this.log.append('connection', tone, message),
        });
        this.shortcuts = new ShortcutManager({
            clock: options.clock,
            shortcuts: options.shortcuts,
            send: event => this.connection.send(event),
            safeMode: () => this.settings.safeMode,
            log: (source, tone, message) => this.log.append(source, tone, message),
            notify: (title, body) => options.notify?.(title, body),
            onChange: () => this.changed(),
        });
        this.runner = new CommandRunner({
            clock: options.clock,
            host: () => this.currentHost(),
            policy: () => ({ ...this.settings, voicebanKeys: voicebanKeysOf(this.settings.keyBindings) }),
            reply: event => {
                if (!this.connection.send(event)) {
                    this.log.append(
                        'connection',
                        'warning',
                        `Could not tell brobot the ${event.type.replace('_complete', '')} is over: not connected`,
                    );
                }
            },
            log: (source, tone, message) => this.log.append(source, tone, message),
            onActiveChange: active => {
                this.activeBans = active;
                this.changed();
            },
        });
    }

    /** Connect if configured. Call once, after the window and tray exist. */
    start(): void {
        this.options.gameRelay?.watchRun?.(run => {
            const was = this.horrorRun;
            this.horrorRun = run;
            if (run.live !== was.live) {
                this.log.append('bot', 'info', run.live ? `The horror game started a run: showing its rewards` : 'The horror run is over: hiding its rewards');
            }
            this.sendHorrorRun();
        }, preview => {
            // brobot decides whether to post the dream's rules (live mode only)
            this.connection.send({ type: 'horror_preview', dream: preview.dream, ...(preview.name ? { name: preview.name } : {}) });
        });
        const host = this.hostInfo();
        this.log.append(
            'app',
            'info',
            host.kind === 'windows' ? 'Ready: host control is live' : `Ready: dry run — ${host.reason ?? ''}`,
        );
        this.shortcuts.apply(this.settings.keyBindings);
        this.applyConnection();
    }

    snapshot(): ClientSnapshot {
        return {
            version: this.options.version,
            connection: this.connectionStatus,
            settings: { ...this.settings, hasSecret: this.secret() !== null },
            host: this.hostInfo(),
            active: this.activeBans,
            shortcuts: this.shortcuts.status,
            log: this.log.all,
            secureStorageAvailable: this.options.store.secureStorageAvailable,
        };
    }

    onChange(listener: (snapshot: ClientSnapshot) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /** Rejects (throws) with a message the window shows beside the field. */
    updateSettings(patch: SettingsPatch): ClientSnapshot {
        let serverUrl = this.settings.serverUrl;
        if (patch.serverUrl !== undefined) {
            const normalized = normalizeServerUrl(patch.serverUrl);
            if (!normalized.ok) throw new Error(normalized.error);
            serverUrl = normalized.url;
        }
        const keyBindings: KeyBindings = { ...this.settings.keyBindings, ...patch.keyBindings };
        const bindingError = bindingsError(keyBindings);
        if (bindingError !== null) throw new Error(bindingError);
        const next: StoredSettings = {
            ...this.settings,
            serverUrl,
            commands: { ...this.settings.commands, ...patch.commands },
            keyBindings,
            safeMode: patch.safeMode ?? this.settings.safeMode,
            paused: patch.paused ?? this.settings.paused,
            startWithWindows: patch.startWithWindows ?? this.settings.startWithWindows,
        };
        this.logSettingChanges(this.settings, next);
        this.commit(next);
        return this.snapshot();
    }

    setSecret(secret: string): ClientSnapshot {
        const trimmed = secret.trim();
        this.options.store.writeSecret(trimmed === '' ? null : trimmed);
        this.log.append('app', 'info', trimmed === '' ? 'Secret removed' : 'Secret saved (encrypted)');
        this.commit(this.settings);
        return this.snapshot();
    }

    test(command: BanCommand): void {
        void this.runner.test(command);
    }

    /**
     * Whether `combo` may become `binding`: the shared rules, and for a
     * shortcut whether Windows would let brobot have it.
     */
    checkBinding(binding: KeyBindingId, combo: KeyComboSetting): BindingCheck {
        const check = checkBinding(binding, combo, this.settings.keyBindings);
        if (check.errors.length > 0 || isPressedBinding(binding)) return check;
        const taken = this.shortcuts.probe(binding, combo);
        return taken === null ? check : { ...check, warnings: [...check.warnings, taken] };
    }

    /** The window is waiting for a new combination: let go of the shortcuts until it is done. */
    captureKeys(active: boolean): void {
        this.shortcuts.suspend(active);
    }

    /** A shortcut sends its event as if pressed; a voiceban key is pressed once. Safe mode only logs. */
    async testBinding(binding: KeyBindingId): Promise<void> {
        if (!isPressedBinding(binding)) {
            this.shortcuts.press(binding, true);
            return;
        }
        const combo = this.settings.keyBindings[binding];
        const what = `${describeCombo(combo)} (overlay ${binding === 'voiceban_start' ? 'on' : 'off'})`;
        if (combo === 'none') {
            this.log.append('app', 'info', `Test: ${BINDING_LABEL[binding]} is off, so there is no key to press`);
            return;
        }
        const host = this.currentHost();
        const result = await host.pressKey(combo);
        if (host.kind === 'dry-run') {
            this.log.append('host', 'info', `Test: Would press ${what} (safe mode: nothing was pressed)`);
        } else if (result.ok) {
            this.log.append('host', 'success', `Test: Pressed ${what}`);
        } else {
            this.log.append('host', 'warning', `Test: Could not press ${what}: ${result.error}`);
        }
    }

    releaseAll(): void {
        if (this.activeBans.length === 0) return;
        this.log.append('app', 'info', 'Released by the streamer');
        this.runner.releaseAll();
    }

    reconnect(): void {
        if (this.target() === null) {
            this.log.append('app', 'warning', 'Cannot connect yet: set the server URL and the secret first');
            return;
        }
        this.log.append('connection', 'info', 'Reconnecting now');
        this.connection.reconnectNow();
    }

    /** A line from outside the controller (the updater) in the same log. */
    appendLog(source: LogSource, tone: LogTone, message: string): void {
        this.log.append(source, tone, message);
    }

    clearLog(): void {
        this.log.clear();
        this.changed();
    }

    /** Stop listening and undo anything in progress. Called on quit. */
    shutdown(): void {
        this.options.gameRelay?.stop?.();
        this.shortcuts.stop();
        this.runner.releaseAll();
        this.connection.stop();
    }

    // ── internals ─────────────────────────────────────────────────────────

    private sendHorrorRun(): void {
        const run = this.horrorRun;
        this.connection.send(run.live && run.dream ? { type: 'horror_run', live: true, dream: run.dream } : { type: 'horror_run', live: run.live });
    }

    private commit(next: StoredSettings): void {
        const firstSetup = !next.setupComplete && this.secret() !== null;
        if (firstSetup) {
            // The owner's rule: start-with-Windows defaults ON once the app is
            // set up. Done once, here, so turning it off later sticks.
            next = { ...next, setupComplete: true, startWithWindows: true };
            this.log.append(
                'app',
                'info',
                'Setup complete. brobot will start with Windows — turn that off in Settings or the tray menu',
            );
        }
        const loginChanged = next.startWithWindows !== this.settings.startWithWindows || firstSetup;
        this.settings = next;
        this.options.store.save(next);
        this.shortcuts.apply(next.keyBindings);
        if (loginChanged) this.applyLoginItem();
        this.applyConnection();
        this.changed();
    }

    private applyLoginItem(): void {
        if (!this.options.loginItems.supported) {
            this.log.append('app', 'info', 'Start with Windows applies to the installed app, not a development run');
            return;
        }
        this.options.loginItems.set(this.settings.startWithWindows);
    }

    private applyConnection(): void {
        this.connection.configure(this.target());
    }

    private target(): { url: string; secret: string } | null {
        const secret = this.secret();
        const url = this.options.override?.serverUrl ?? this.settings.serverUrl;
        return secret === null ? null : { url, secret };
    }

    private secret(): string | null {
        return this.options.override?.secret ?? this.options.store.readSecret();
    }

    private currentHost(): HostControl {
        return this.hostInfo().kind === 'windows' && this.options.windowsHost !== null
            ? this.options.windowsHost
            : this.dryRun;
    }

    private hostInfo(): HostInfo {
        if (this.settings.safeMode) return { kind: 'dry-run', reason: 'safe mode is on' };
        if (this.options.windowsHost === null) {
            return { kind: 'dry-run', reason: `host control needs Windows; this is ${this.options.platform}` };
        }
        return { kind: 'windows', reason: null };
    }

    private logSettingChanges(before: StoredSettings, after: StoredSettings): void {
        const say = (message: string): void => void this.log.append('app', 'info', message);
        if (before.serverUrl !== after.serverUrl) say(`Server set to ${after.serverUrl}`);
        if (before.paused !== after.paused) say(after.paused ? 'Commands paused' : 'Commands resumed');
        if (before.safeMode !== after.safeMode) {
            say(after.safeMode ? 'Safe mode on: commands are simulated' : 'Safe mode off: commands act for real');
        }
        for (const command of ['chatban', 'voiceban'] as const) {
            if (before.commands[command] !== after.commands[command]) {
                say(`${command} ${after.commands[command] ? 'enabled' : 'disabled'}`);
            }
        }
        for (const id of KEY_BINDING_IDS) {
            const combo = after.keyBindings[id];
            if (before.keyBindings[id] === combo) continue;
            if (isPressedBinding(id)) {
                const moment = id === 'voiceban_start' ? 'starts' : 'ends';
                say(combo === 'none' ? `Nothing is pressed when a voiceban ${moment}` : `${describeCombo(combo)} is pressed when a voiceban ${moment}`);
            } else {
                say(combo === 'none' ? `${BINDING_LABEL[id]} shortcut off` : `${BINDING_LABEL[id]} shortcut set to ${describeCombo(combo)}`);
            }
        }
        if (before.startWithWindows !== after.startWithWindows) {
            say(after.startWithWindows ? 'Will start with Windows' : 'Will not start with Windows');
        }
    }

    private changed(): void {
        const snapshot = this.snapshot();
        this.options.emitSnapshot(snapshot);
        for (const listener of this.listeners) listener(snapshot);
    }
}
