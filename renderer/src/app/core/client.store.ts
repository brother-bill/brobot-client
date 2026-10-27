/**
 * The window's state, as signals, fed by the host's pushes: one snapshot of
 * everything plus the log as it grows. Every component reads from here and
 * every action goes through here, so exactly one file names host operations.
 */

import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import {
    EVENT_LOG_LIMIT,
    type BanCommand,
    type BindingCheck,
    type ClientSnapshot,
    type KeyBindingId,
    type KeyComboSetting,
    type LogEntry,
    type SettingsPatch,
    type UpdateStatus,
} from '@brobot-client/shared';
import { HOST_BRIDGE, UnavailableBridge, isDesktopShell, messageOf } from './host-bridge';

@Injectable({ providedIn: 'root' })
export class ClientStore {
    private readonly bridge = inject(HOST_BRIDGE);

    readonly desktop = isDesktopShell();

    private readonly _snapshot = signal<ClientSnapshot | null>(null);
    private readonly _log = signal<readonly LogEntry[]>([]);
    private readonly _error = signal<string | null>(this.desktop ? null : UnavailableBridge.reason);
    private readonly _now = signal(Date.now());
    private readonly _update = signal<UpdateStatus | null>(null);

    readonly snapshot = this._snapshot.asReadonly();
    readonly log = this._log.asReadonly();
    /** The last action that failed, in words; cleared by the next success. */
    readonly error = this._error.asReadonly();
    /** Ticks every second, for countdowns and "last heard 12 s ago". */
    readonly now = this._now.asReadonly();
    /** Updates: whether a newer brobot exists, and how its download is going. */
    readonly update = this._update.asReadonly();

    readonly connection = computed(() => this._snapshot()?.connection ?? null);
    readonly settings = computed(() => this._snapshot()?.settings ?? null);
    readonly host = computed(() => this._snapshot()?.host ?? null);
    readonly active = computed(() => this._snapshot()?.active ?? []);

    constructor() {
        const destroyRef = inject(DestroyRef);
        const offSnapshot = this.bridge.on('client.snapshot', snapshot => this.apply(snapshot));
        const offLog = this.bridge.on('log.appended', entry => this.append(entry));
        const offUpdate = this.bridge.on('update.status', status => this._update.set(status));
        const ticker = setInterval(() => this._now.set(Date.now()), 1000);
        destroyRef.onDestroy(() => {
            offSnapshot();
            offLog();
            offUpdate();
            clearInterval(ticker);
        });
        void this.refresh();
    }

    async refresh(): Promise<void> {
        if (!this.desktop) return;
        await this.run(async () => {
            this.apply(await this.bridge.invoke('client.snapshot', undefined));
            this._update.set(await this.bridge.invoke('update.status', undefined));
        });
    }

    /** Resolves `false` (with {@link error} set) when the host refused the change. */
    updateSettings(patch: SettingsPatch): Promise<boolean> {
        return this.run(async () => this.apply(await this.bridge.invoke('settings.update', patch)));
    }

    setSecret(secret: string): Promise<boolean> {
        return this.run(async () => this.apply(await this.bridge.invoke('settings.setSecret', { secret })));
    }

    test(command: BanCommand): Promise<boolean> {
        return this.run(() => this.bridge.invoke('command.test', { command }));
    }

    /** Whether `combo` may become `binding`; null (with {@link error} set) when the host could not say. */
    async checkBinding(binding: KeyBindingId, combo: KeyComboSetting): Promise<BindingCheck | null> {
        let check: BindingCheck | null = null;
        await this.run(async () => {
            check = await this.bridge.invoke('keyBindings.check', { binding, combo });
        });
        return check;
    }

    /** While true, the shortcuts are let go so the window can see the keys. */
    captureKeys(active: boolean): Promise<boolean> {
        return this.run(() => this.bridge.invoke('keyBindings.capture', { active }));
    }

    testBinding(binding: KeyBindingId): Promise<boolean> {
        return this.run(() => this.bridge.invoke('keyBindings.test', { binding }));
    }

    releaseAll(): Promise<boolean> {
        return this.run(() => this.bridge.invoke('command.releaseAll', undefined));
    }

    reconnect(): Promise<boolean> {
        return this.run(() => this.bridge.invoke('connection.reconnect', undefined));
    }

    clearLog(): Promise<boolean> {
        return this.run(async () => {
            await this.bridge.invoke('log.clear', undefined);
            this._log.set([]);
        });
    }

    checkForUpdate(): Promise<boolean> {
        return this.run(async () => this._update.set(await this.bridge.invoke('update.check', undefined)));
    }

    /** Downloads and installs; brobot quits and comes back as the new version. */
    installUpdate(): Promise<boolean> {
        return this.run(() => this.bridge.invoke('update.install', undefined));
    }

    dismissUpdate(): Promise<boolean> {
        return this.run(async () => this._update.set(await this.bridge.invoke('update.dismiss', undefined)));
    }

    dismissError(): void {
        this._error.set(null);
    }

    private apply(snapshot: ClientSnapshot): void {
        this._snapshot.set(snapshot);
        this._log.set(snapshot.log);
    }

    /** Pushed lines arrive between snapshots; ids keep the two from doubling up. */
    private append(entry: LogEntry): void {
        this._log.update(log => {
            const last = log.at(-1);
            if (last !== undefined && entry.id <= last.id) return log;
            const next = [...log, entry];
            return next.length > EVENT_LOG_LIMIT ? next.slice(next.length - EVENT_LOG_LIMIT) : next;
        });
    }

    private async run(work: () => Promise<unknown>): Promise<boolean> {
        try {
            await work();
            this._error.set(null);
            return true;
        } catch (error) {
            this._error.set(messageOf(error));
            return false;
        }
    }
}
