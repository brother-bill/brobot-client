/**
 * The state the main process owns and the window displays: the connection,
 * the host driver in use, any ban in progress, and the event log.
 */

import type { BanCommand } from './server-events';
import type { PublicSettings } from './settings';

/**
 * The socket's lifecycle.
 *
 * - `disconnected` — not trying: no server/secret configured, or stopped.
 * - `connecting`   — a socket is open and waiting for the upgrade.
 * - `connected`    — the upgrade succeeded; commands can arrive.
 * - `reconnecting` — the last attempt failed or dropped; the next one is
 *   scheduled at `nextRetryAt`.
 */
export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

export interface ConnectionStatus {
    readonly state: ConnectionState;
    /** Consecutive failed attempts since the last stable connection. */
    readonly attempt: number;
    /** Epoch ms of the next attempt, while `reconnecting`. */
    readonly nextRetryAt: number | null;
    /** Why the last attempt failed or the socket dropped, in words. */
    readonly lastError: string | null;
    /** Epoch ms the current connection opened, while `connected`. */
    readonly connectedAt: number | null;
    /**
     * Epoch ms of the last frame or ping from the server. brobot pings every
     * 15 s, so a value much older than that means the link is going stale.
     */
    readonly lastHeardAt: number | null;
}

export const INITIAL_CONNECTION_STATUS: ConnectionStatus = {
    state: 'disconnected',
    attempt: 0,
    nextRetryAt: null,
    lastError: null,
    connectedAt: null,
    lastHeardAt: null,
};

/** Which HostControl implementation is answering commands right now. */
export interface HostInfo {
    readonly kind: 'windows' | 'dry-run';
    /** Why it is the dry run, when it is: safe mode, or not on Windows. */
    readonly reason: string | null;
}

/** A ban currently being applied to this machine. */
export interface ActiveBan {
    readonly command: BanCommand;
    readonly startedAt: number;
    readonly endsAt: number;
    /** Started from the window's Test button rather than by brobot. */
    readonly test: boolean;
    /** Applied by the dry-run driver: nothing on the machine actually changed. */
    readonly dryRun: boolean;
}

/** Who a log line is about. */
export type LogSource = 'bot' | 'host' | 'connection' | 'app';

/** How a log line should read. Every tone also carries its meaning in words. */
export type LogTone = 'info' | 'success' | 'warning' | 'error';

export interface LogEntry {
    readonly id: number;
    readonly at: number;
    readonly source: LogSource;
    readonly tone: LogTone;
    readonly message: string;
}

/** Everything the window shows, pushed whole on every change. */
export interface ClientSnapshot {
    readonly version: string;
    readonly connection: ConnectionStatus;
    readonly settings: PublicSettings;
    readonly host: HostInfo;
    readonly active: readonly ActiveBan[];
    /** Oldest first, capped; see `EVENT_LOG_LIMIT`. */
    readonly log: readonly LogEntry[];
    /** Whether `safeStorage` can encrypt here. When false, a secret cannot be saved. */
    readonly secureStorageAvailable: boolean;
}

/** How many log lines the main process keeps. */
export const EVENT_LOG_LIMIT = 200;

/** How long a Test button run lasts: long enough to try, short enough not to matter. */
export const TEST_DURATION_MS = 5000;
