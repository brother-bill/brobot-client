/**
 * The `/api/ashketchum` connection: one socket, a reconnect state machine, and
 * a dead-man heartbeat.
 *
 * Deliberately free of `ws` and of Electron. The socket arrives through a
 * {@link SocketFactory} (the real one is `services/ws-socket.ts`) and time
 * through a {@link Clock}, so every transition below is exercised by
 * `connection.spec.ts` without a network or a wall clock.
 *
 * ## Staleness
 *
 * Each socket gets a generation number, and its callbacks are dropped once a
 * newer socket exists. Without that, the `close` of a socket we terminated on
 * purpose (a settings change, a heartbeat timeout) would arrive after its
 * replacement opened and schedule a second, competing reconnect.
 */

import {
    INITIAL_CONNECTION_STATUS,
    parseStreamerServerEvent,
    type ChatbanEvent,
    type ConnectionStatus,
    type LogTone,
    type StreamerClientEvent,
    type VoicebanEvent,
} from '@brobot-client/shared';
import { DEFAULT_BACKOFF, backoffDelay, type BackoffPolicy } from './backoff';
import type { Clock, TimerHandle } from './clock';

export interface SocketHandlers {
    onOpen(): void;
    onMessage(text: string): void;
    /** A protocol-level ping frame (ws answers it with a pong by itself). */
    onProtocolPing(): void;
    onClose(code: number, reason: string): void;
    /** Always followed by `onClose`, as ws does; used only for its message. */
    onError(error: Error): void;
}

export interface SocketHandle {
    send(text: string): void;
    /** Destroys the connection immediately, without the closing handshake. */
    terminate(): void;
}

export type SocketFactory = (url: string, secret: string, handlers: SocketHandlers) => SocketHandle;

export interface ConnectionTarget {
    readonly url: string;
    readonly secret: string;
}

export type BanEvent = ChatbanEvent | VoicebanEvent;

export interface ConnectionOptions {
    readonly factory: SocketFactory;
    readonly clock: Clock;
    readonly onStatus: (status: ConnectionStatus) => void;
    readonly onBan: (event: BanEvent) => void;
    readonly onLog: (tone: LogTone, message: string) => void;
    readonly random?: () => number;
    readonly policy?: BackoffPolicy;
    /**
     * Silence after which the link is presumed dead. brobot pings every 15 s,
     * so this is two missed pings plus slack.
     */
    readonly heartbeatTimeoutMs?: number;
    /** An upgrade that has not answered in this long is abandoned. */
    readonly connectTimeoutMs?: number;
}

export const HEARTBEAT_TIMEOUT_MS = 40_000;
export const CONNECT_TIMEOUT_MS = 15_000;

export class ConnectionManager {
    private target: ConnectionTarget | null = null;
    private socket: SocketHandle | null = null;
    private generation = 0;
    private openedAt: number | null = null;
    private retryTimer: TimerHandle | null = null;
    private heartbeatTimer: TimerHandle | null = null;
    private connectTimer: TimerHandle | null = null;
    /** Set by the socket's `error`, consumed by the `close` that follows it. */
    private pendingError: string | null = null;
    private _status: ConnectionStatus = INITIAL_CONNECTION_STATUS;

    private readonly random: () => number;
    private readonly policy: BackoffPolicy;
    private readonly heartbeatTimeoutMs: number;
    private readonly connectTimeoutMs: number;

    constructor(private readonly options: ConnectionOptions) {
        this.random = options.random ?? Math.random;
        this.policy = options.policy ?? DEFAULT_BACKOFF;
        this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS;
        this.connectTimeoutMs = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
    }

    get status(): ConnectionStatus {
        return this._status;
    }

    /**
     * Point the connection somewhere, or nowhere (`null`: stop and stay
     * disconnected). A changed target reconnects immediately with a fresh
     * backoff; the same target again is a no-op, so this can be called on
     * every settings save.
     */
    configure(target: ConnectionTarget | null): void {
        const same =
            target !== null &&
            this.target !== null &&
            target.url === this.target.url &&
            target.secret === this.target.secret;
        if (same && this._status.state !== 'disconnected') return;

        this.target = target;
        this.teardown();
        if (target === null) {
            this.update({ ...INITIAL_CONNECTION_STATUS });
            return;
        }
        this.update({ ...INITIAL_CONNECTION_STATUS });
        this.connect();
    }

    /** Skip the backoff and try again now (the window's Reconnect button). */
    reconnectNow(): void {
        if (this.target === null) return;
        this.teardown();
        this.update({ ...this._status, attempt: 0, nextRetryAt: null });
        this.connect();
    }

    /** Sends a frame if connected; `false` when there is nowhere to send it. */
    send(event: StreamerClientEvent): boolean {
        if (this.socket === null || this._status.state !== 'connected') return false;
        this.socket.send(JSON.stringify(event));
        return true;
    }

    stop(): void {
        this.configure(null);
    }

    // ── lifecycle ─────────────────────────────────────────────────────────

    private connect(): void {
        const target = this.target;
        if (target === null) return;
        const generation = ++this.generation;
        const current = (): boolean => generation === this.generation;
        this.pendingError = null;
        this.openedAt = null;
        this.update({ ...this._status, state: 'connecting', nextRetryAt: null, connectedAt: null });

        this.connectTimer = this.options.clock.setTimeout(() => {
            this.connectTimer = null;
            if (!current()) return;
            this.pendingError = `The server did not answer within ${Math.round(this.connectTimeoutMs / 1000)} s`;
            this.drop();
        }, this.connectTimeoutMs);

        try {
            this.socket = this.options.factory(target.url, target.secret, {
                onOpen: () => {
                    if (current()) this.handleOpen();
                },
                onMessage: text => {
                    if (current()) this.handleMessage(text);
                },
                onProtocolPing: () => {
                    if (current()) this.heard();
                },
                onError: error => {
                    if (current()) this.pendingError = describeSocketError(error);
                },
                onClose: (code, reason) => {
                    if (!current()) return;
                    this.pendingError ??= describeClose(code, reason);
                    this.drop();
                },
            });
        } catch (error) {
            // `new WebSocket()` throws synchronously on a malformed URL.
            this.socket = null;
            this.pendingError = describeSocketError(error instanceof Error ? error : new Error(String(error)));
            this.drop();
        }
    }

    private handleOpen(): void {
        this.clearTimer('connectTimer');
        const now = this.options.clock.now();
        this.openedAt = now;
        this.pendingError = null;
        const wasRetrying = this._status.attempt > 0;
        this.update({
            ...this._status,
            state: 'connected',
            connectedAt: now,
            lastHeardAt: now,
            lastError: null,
            nextRetryAt: null,
        });
        this.options.onLog('success', wasRetrying ? 'Reconnected to brobot' : 'Connected to brobot');
        this.armHeartbeat();
    }

    private handleMessage(text: string): void {
        this.heard();
        const event = parseStreamerServerEvent(text);
        if (event === null) {
            // Unknown types are expected (the contract lets the server add
            // them first); only say something when it is not even JSON.
            if (!looksLikeJsonObject(text)) {
                this.options.onLog('warning', 'Ignored a malformed message from the server');
            }
            return;
        }
        if (event.type === 'ping') {
            this.send({ type: 'pong', sentAt: event.sentAt });
            return;
        }
        this.options.onBan(event);
    }

    /** Any sign of life from the server pushes the dead-man timer back. */
    private heard(): void {
        this.update({ ...this._status, lastHeardAt: this.options.clock.now() });
        this.armHeartbeat();
    }

    private armHeartbeat(): void {
        this.clearTimer('heartbeatTimer');
        const generation = this.generation;
        this.heartbeatTimer = this.options.clock.setTimeout(() => {
            this.heartbeatTimer = null;
            if (generation !== this.generation) return;
            this.pendingError = `No word from the server in ${Math.round(this.heartbeatTimeoutMs / 1000)} s`;
            this.drop();
        }, this.heartbeatTimeoutMs);
    }

    /**
     * The current socket is gone (closed, errored, timed out). Tear it down,
     * and schedule the next attempt unless we have been told to stop.
     */
    private drop(): void {
        const wasConnected = this._status.state === 'connected';
        const now = this.options.clock.now();
        const stable = this.openedAt !== null && now - this.openedAt >= this.policy.stableAfterMs;
        const reason = this.pendingError ?? 'Connection lost';
        const previousError = this._status.lastError;
        this.teardown();

        if (this.target === null) {
            this.update({ ...INITIAL_CONNECTION_STATUS });
            return;
        }

        const attempt = stable ? 1 : this._status.attempt + 1;
        const delay = backoffDelay(attempt, this.policy, this.random());
        this.update({
            ...this._status,
            state: 'reconnecting',
            attempt,
            nextRetryAt: now + delay,
            lastError: reason,
            connectedAt: null,
        });
        // One line per change of fortune, not one per retry: an hour-long
        // outage at a 60 s cap would otherwise fill the log with one sentence.
        if (wasConnected) {
            this.options.onLog('warning', `Disconnected: ${reason}. Reconnecting…`);
        } else if (reason !== previousError) {
            this.options.onLog('error', `Could not connect: ${reason}`);
        }
        this.retryTimer = this.options.clock.setTimeout(() => {
            this.retryTimer = null;
            this.connect();
        }, delay);
    }

    /** Forget the current socket and every timer. Does not touch `target`. */
    private teardown(): void {
        this.generation++;
        this.clearTimer('retryTimer');
        this.clearTimer('heartbeatTimer');
        this.clearTimer('connectTimer');
        const socket = this.socket;
        this.socket = null;
        this.openedAt = null;
        this.pendingError = null;
        if (socket !== null) {
            try {
                socket.terminate();
            } catch {
                // Already dead; that was the point.
            }
        }
    }

    private clearTimer(name: 'retryTimer' | 'heartbeatTimer' | 'connectTimer'): void {
        const handle = this[name];
        if (handle !== null) {
            this.options.clock.clearTimeout(handle);
            this[name] = null;
        }
    }

    private update(status: ConnectionStatus): void {
        this._status = status;
        this.options.onStatus(status);
    }
}

/** A socket error in the words a streamer can act on. */
export function describeSocketError(error: Error): string {
    const message = error.message;
    const status = /Unexpected server response: (\d{3})/.exec(message)?.[1];
    if (status === '401' || status === '403') {
        return 'brobot refused the secret — check it in Settings';
    }
    if (status === '404') {
        return 'Nothing is listening at that address (404) — check the server URL';
    }
    if (status !== undefined) {
        return `The server answered ${status} instead of opening the connection`;
    }
    const code = (error as Error & { code?: unknown }).code;
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'Server address not found';
    if (code === 'ECONNREFUSED') return 'The server refused the connection';
    if (code === 'ETIMEDOUT' || code === 'ECONNRESET') return 'The network dropped the connection';
    return message || 'Connection error';
}

function describeClose(code: number, reason: string): string {
    if (reason.trim() !== '') return reason.trim();
    if (code === 1000) return 'The server closed the connection';
    if (code === 1001) return 'The server is restarting';
    return 'Connection lost';
}

function looksLikeJsonObject(text: string): boolean {
    try {
        const value: unknown = JSON.parse(text);
        return typeof value === 'object' && value !== null;
    } catch {
        return false;
    }
}
