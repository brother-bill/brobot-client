/**
 * The update flow: look for a newer brobot now and then, tell the streamer
 * once, and download and install it only when they click Install.
 *
 * Nothing here knows about GitHub or the filesystem. The backend (in
 * `services/update-backend.ts`) answers "is there a newer one?", fetches it
 * and runs the installer; this decides when to ask and what the window, the
 * tray and the notification show. With no backend (development, the portable
 * exe, not Windows) it stays `unsupported` and never asks.
 */

import {
    UPDATE_CHECK_INTERVAL_MS,
    UPDATE_FIRST_CHECK_DELAY_MS,
    type UpdateRelease,
    type UpdateStatus,
} from '@brobot-client/shared';
import type { Clock, TimerHandle } from './clock';

export interface UpdateBackend {
    /** The newer release, or null when this copy is the latest. */
    check(): Promise<UpdateRelease | null>;
    /** Downloads the release the last `check` found. */
    download(onProgress: (percent: number) => void): Promise<void>;
    /** Starts the downloaded installer (silent, restarts brobot after) and quits. Rejects if it cannot start. */
    install(): Promise<void>;
}

export interface UpdaterOptions {
    readonly clock: Clock;
    readonly currentVersion: string;
    /** Null where this copy cannot update itself; `unsupportedReason` says why. */
    readonly backend: UpdateBackend | null;
    readonly unsupportedReason?: string;
    readonly emit: (status: UpdateStatus) => void;
    /** Called once per newly found version: the Windows notification. */
    readonly announce: (release: UpdateRelease) => void;
    readonly log: (tone: 'info' | 'success' | 'warning' | 'error', message: string) => void;
}

export class Updater {
    private status: UpdateStatus;
    private timer: TimerHandle | null = null;
    private announced: string | null = null;
    private readonly listeners = new Set<(status: UpdateStatus) => void>();

    constructor(private readonly options: UpdaterOptions) {
        this.status = {
            phase: options.backend === null ? 'unsupported' : 'idle',
            currentVersion: options.currentVersion,
            unsupportedReason:
                options.backend === null ? (options.unsupportedReason ?? 'This copy cannot update itself.') : null,
            update: null,
            percent: 0,
            lastCheckedAt: null,
            lastError: null,
            dismissed: false,
        };
    }

    snapshot(): UpdateStatus {
        return this.status;
    }

    onChange(listener: (status: UpdateStatus) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /** Schedules the first look; later ones follow every `UPDATE_CHECK_INTERVAL_MS`. */
    start(): void {
        if (this.options.backend === null) return;
        this.schedule(UPDATE_FIRST_CHECK_DELAY_MS);
    }

    stop(): void {
        if (this.timer !== null) this.options.clock.clearTimeout(this.timer);
        this.timer = null;
    }

    /**
     * Asks for a newer release. `manual` is the window's "Check for updates":
     * it un-hides a dismissed release and logs "up to date", which the timed
     * checks keep quiet about.
     */
    async check(manual = false): Promise<UpdateStatus> {
        const backend = this.options.backend;
        if (backend === null || this.busy()) return this.status;
        const previous = this.status;
        this.set({ phase: 'checking', lastError: null });
        try {
            const release = await backend.check();
            const now = this.options.clock.now();
            if (release === null) {
                this.set({ phase: 'idle', update: null, lastCheckedAt: now, dismissed: false });
                if (manual) this.options.log('info', `brobot ${this.status.currentVersion} is the latest version`);
            } else {
                const sameRelease = previous.update?.version === release.version;
                this.set({
                    phase: 'available',
                    update: release,
                    lastCheckedAt: now,
                    // A dismissed release stays out of the way until a newer
                    // one turns up, or the streamer asks.
                    dismissed: sameRelease && previous.dismissed && !manual,
                });
                if (this.announced !== release.version) {
                    this.announced = release.version;
                    this.options.log('info', `brobot ${release.version} is available`);
                    this.options.announce(release);
                }
            }
        } catch (error) {
            this.set({
                // A release already found stays on offer: only its download
                // or install failing is an error the window shows as one.
                phase: previous.update !== null ? 'available' : 'error',
                update: previous.update,
                lastCheckedAt: this.options.clock.now(),
                lastError: `Could not check for updates: ${messageOf(error)}`,
            });
            // A timed check failing (offline, GitHub down) is not worth a red
            // log line every four hours; one the streamer asked for is.
            if (manual) this.options.log('warning', this.status.lastError ?? '');
        } finally {
            this.schedule(UPDATE_CHECK_INTERVAL_MS);
        }
        return this.status;
    }

    /** Install now: download the known release, then hand over to the installer. */
    async install(): Promise<void> {
        const backend = this.options.backend;
        const release = this.status.update;
        if (backend === null || release === null || this.busy()) return;
        this.stop();
        this.set({ phase: 'downloading', percent: 0, lastError: null, dismissed: false });
        this.options.log('info', `Downloading brobot ${release.version}`);
        try {
            await backend.download(percent => this.set({ percent: clampPercent(percent) }));
        } catch (error) {
            const message = `The update did not download: ${messageOf(error)}`;
            this.set({ phase: 'error', lastError: message });
            this.options.log('error', message);
            this.schedule(UPDATE_CHECK_INTERVAL_MS);
            return;
        }
        this.set({ phase: 'installing', percent: 100 });
        this.options.log('success', `Installing brobot ${release.version}; brobot restarts by itself`);
        try {
            await backend.install();
        } catch (error) {
            const message = `The installer did not start: ${messageOf(error)}`;
            this.set({ phase: 'error', lastError: message });
            this.options.log('error', message);
            this.schedule(UPDATE_CHECK_INTERVAL_MS);
        }
    }

    /** Later: stop offering this release in the window. The tray keeps the item. */
    dismiss(): UpdateStatus {
        if (this.status.update !== null && (this.status.phase === 'available' || this.status.phase === 'error')) {
            this.set({ dismissed: true });
        }
        return this.status;
    }

    private busy(): boolean {
        return ['checking', 'downloading', 'installing'].includes(this.status.phase);
    }

    private schedule(ms: number): void {
        this.stop();
        this.timer = this.options.clock.setTimeout(() => {
            this.timer = null;
            void this.check();
        }, ms);
    }

    private set(patch: Partial<UpdateStatus>): void {
        this.status = { ...this.status, ...patch };
        this.options.emit(this.status);
        for (const listener of this.listeners) listener(this.status);
    }
}

function clampPercent(percent: number): number {
    return Number.isFinite(percent) ? Math.min(100, Math.max(0, Math.round(percent))) : 0;
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

