import { beforeEach, describe, expect, it } from 'vitest';
import type { ConnectionStatus, LogTone } from '@brobot-client/shared';
import { FakeClock } from '../testing/fake-clock';
import {
    CONNECT_TIMEOUT_MS,
    ConnectionManager,
    HEARTBEAT_TIMEOUT_MS,
    describeSocketError,
    type BanEvent,
    type SocketHandlers,
} from './connection';

class FakeSocket {
    sent: string[] = [];
    terminated = false;
    constructor(
        readonly url: string,
        readonly secret: string,
        readonly handlers: SocketHandlers,
    ) {}
    send(text: string): void {
        this.sent.push(text);
    }
    terminate(): void {
        this.terminated = true;
    }
}

const TARGET = { url: 'wss://admin.brobot.live/api/ashketchum', secret: 's3cret' };

describe('ConnectionManager', () => {
    let clock: FakeClock;
    let sockets: FakeSocket[];
    let statuses: ConnectionStatus[];
    let bans: BanEvent[];
    let logs: { tone: LogTone; message: string }[];
    let manager: ConnectionManager;

    const latest = (): FakeSocket => sockets[sockets.length - 1]!;
    const state = (): ConnectionStatus['state'] => manager.status.state;

    beforeEach(() => {
        clock = new FakeClock();
        sockets = [];
        statuses = [];
        bans = [];
        logs = [];
        manager = new ConnectionManager({
            clock,
            random: () => 0,
            factory: (url, secret, handlers) => {
                const socket = new FakeSocket(url, secret, handlers);
                sockets.push(socket);
                return socket;
            },
            onStatus: status => statuses.push(status),
            onBan: event => bans.push(event),
            onLog: (tone, message) => logs.push({ tone, message }),
        });
    });

    it('stays disconnected until it has somewhere to go', () => {
        expect(state()).toBe('disconnected');
        manager.configure(null);
        expect(sockets).toHaveLength(0);
    });

    it('connects with the secret and reports each step', () => {
        manager.configure(TARGET);
        expect(state()).toBe('connecting');
        expect(latest().url).toBe(TARGET.url);
        expect(latest().secret).toBe(TARGET.secret);

        latest().handlers.onOpen();
        expect(state()).toBe('connected');
        expect(manager.status.connectedAt).toBe(clock.now());
        expect(logs.at(-1)).toEqual({ tone: 'success', message: 'Connected to brobot' });
    });

    it('reconnects with a doubling backoff after failures', () => {
        manager.configure(TARGET);
        const delays: number[] = [];
        for (let attempt = 1; attempt <= 4; attempt++) {
            latest().handlers.onClose(1006, '');
            expect(state()).toBe('reconnecting');
            expect(manager.status.attempt).toBe(attempt);
            const delay = manager.status.nextRetryAt! - clock.now();
            delays.push(delay);
            clock.advance(delay - 1);
            expect(sockets).toHaveLength(attempt);
            clock.advance(1);
            expect(sockets).toHaveLength(attempt + 1);
            expect(state()).toBe('connecting');
        }
        // random() is 0, so each delay is the lower half of its window.
        expect(delays).toEqual([500, 1000, 2000, 4000]);
    });

    it('logs a failure once, not on every retry of the same failure', () => {
        manager.configure(TARGET);
        for (let i = 0; i < 3; i++) {
            latest().handlers.onError(new Error('connect ECONNREFUSED'));
            latest().handlers.onClose(1006, '');
            clock.advance(manager.status.nextRetryAt! - clock.now());
        }
        expect(logs.filter(l => l.tone === 'error')).toHaveLength(1);
    });

    it('resets the backoff after a connection that stayed up', () => {
        manager.configure(TARGET);
        latest().handlers.onClose(1006, '');
        clock.advance(manager.status.nextRetryAt! - clock.now());
        latest().handlers.onClose(1006, '');
        expect(manager.status.attempt).toBe(2);
        clock.advance(manager.status.nextRetryAt! - clock.now());

        latest().handlers.onOpen();
        expect(logs.at(-1)?.message).toBe('Reconnected to brobot');
        clock.advance(10_000);
        latest().handlers.onMessage('{"type":"ping","sentAt":1}');
        latest().handlers.onClose(1001, '');
        expect(manager.status.attempt).toBe(1);
        expect(logs.at(-1)).toEqual({ tone: 'warning', message: 'Disconnected: The server is restarting. Reconnecting…' });
    });

    it('does not reset the backoff for a server that accepts and immediately drops', () => {
        manager.configure(TARGET);
        latest().handlers.onOpen();
        latest().handlers.onClose(1006, '');
        clock.advance(manager.status.nextRetryAt! - clock.now());
        latest().handlers.onOpen();
        latest().handlers.onClose(1006, '');
        expect(manager.status.attempt).toBe(2);
    });

    it('answers a JSON ping with a pong and counts it as a sign of life', () => {
        manager.configure(TARGET);
        latest().handlers.onOpen();
        clock.advance(HEARTBEAT_TIMEOUT_MS - 1000);
        latest().handlers.onMessage('{"type":"ping","sentAt":42}');
        expect(latest().sent).toEqual(['{"type":"pong","sentAt":42}']);
        expect(manager.status.lastHeardAt).toBe(clock.now());
        clock.advance(HEARTBEAT_TIMEOUT_MS - 1000);
        expect(state()).toBe('connected');
    });

    it('treats a silent server as dead and reconnects', () => {
        manager.configure(TARGET);
        const first = latest();
        first.handlers.onOpen();
        clock.advance(HEARTBEAT_TIMEOUT_MS / 2);
        first.handlers.onProtocolPing();
        clock.advance(HEARTBEAT_TIMEOUT_MS - 1);
        expect(state()).toBe('connected');
        clock.advance(1);
        expect(first.terminated).toBe(true);
        expect(state()).toBe('reconnecting');
        expect(manager.status.lastError).toBe('No word from the server in 40 s');

        // The terminated socket's own close arrives late and must change nothing.
        const retryAt = manager.status.nextRetryAt;
        first.handlers.onClose(1006, '');
        expect(manager.status.nextRetryAt).toBe(retryAt);
        expect(manager.status.attempt).toBe(1);
    });

    it('abandons an upgrade that never answers', () => {
        manager.configure(TARGET);
        clock.advance(CONNECT_TIMEOUT_MS);
        expect(latest().terminated).toBe(true);
        expect(state()).toBe('reconnecting');
        expect(manager.status.lastError).toBe('The server did not answer within 15 s');
    });

    it('forwards bans and ignores what it does not understand', () => {
        manager.configure(TARGET);
        latest().handlers.onOpen();
        latest().handlers.onMessage('{"type":"chatban","durationMs":300000}');
        latest().handlers.onMessage('{"type":"voiceban","durationMs":30000}');
        latest().handlers.onMessage('{"type":"something-new"}');
        expect(bans).toEqual([
            { type: 'chatban', durationMs: 300000 },
            { type: 'voiceban', durationMs: 30000 },
        ]);
        expect(logs.filter(l => l.tone === 'warning')).toHaveLength(0);

        latest().handlers.onMessage('garbage');
        expect(logs.at(-1)).toEqual({ tone: 'warning', message: 'Ignored a malformed message from the server' });
    });

    it('explains a refused secret in words', () => {
        manager.configure(TARGET);
        latest().handlers.onError(new Error('Unexpected server response: 401'));
        latest().handlers.onClose(1006, '');
        expect(manager.status.lastError).toBe('brobot refused the secret — check it in Settings');
    });

    it('reconnects immediately on a new target and drops the old socket', () => {
        manager.configure(TARGET);
        const old = latest();
        old.handlers.onOpen();
        manager.configure({ ...TARGET, secret: 'rotated' });
        expect(old.terminated).toBe(true);
        expect(latest().secret).toBe('rotated');
        expect(state()).toBe('connecting');

        old.handlers.onClose(1000, '');
        old.handlers.onMessage('{"type":"chatban","durationMs":1000}');
        expect(state()).toBe('connecting');
        expect(bans).toHaveLength(0);
    });

    it('is a no-op when configured with the same target again', () => {
        manager.configure(TARGET);
        manager.configure({ ...TARGET });
        expect(sockets).toHaveLength(1);
    });

    it('skips the wait on reconnectNow', () => {
        manager.configure(TARGET);
        latest().handlers.onClose(1006, '');
        manager.reconnectNow();
        expect(sockets).toHaveLength(2);
        expect(state()).toBe('connecting');
        expect(manager.status.attempt).toBe(0);
        expect(clock.pending).toBe(1); // only the new connect timeout
    });

    it('stops completely: no socket, no timers, no retries', () => {
        manager.configure(TARGET);
        latest().handlers.onOpen();
        manager.stop();
        expect(latest().terminated).toBe(true);
        expect(state()).toBe('disconnected');
        expect(clock.pending).toBe(0);
        clock.advance(10 * 60_000);
        expect(sockets).toHaveLength(1);
    });

    it('sends only while connected', () => {
        expect(manager.send({ type: 'chatban_complete' })).toBe(false);
        manager.configure(TARGET);
        expect(manager.send({ type: 'chatban_complete' })).toBe(false);
        latest().handlers.onOpen();
        expect(manager.send({ type: 'chatban_complete' })).toBe(true);
        expect(latest().sent).toEqual(['{"type":"chatban_complete"}']);
    });

    it('survives a factory that throws on a malformed URL', () => {
        const throwing = new ConnectionManager({
            clock,
            random: () => 0,
            factory: () => {
                throw new Error('Invalid URL');
            },
            onStatus: () => undefined,
            onBan: () => undefined,
            onLog: () => undefined,
        });
        throwing.configure(TARGET);
        expect(throwing.status.state).toBe('reconnecting');
        expect(throwing.status.lastError).toBe('Invalid URL');
    });
});

describe('describeSocketError', () => {
    it('maps network codes to plain words', () => {
        const error = (code: string): Error => Object.assign(new Error(`x ${code}`), { code });
        expect(describeSocketError(error('ENOTFOUND'))).toBe('Server address not found');
        expect(describeSocketError(error('ECONNREFUSED'))).toBe('The server refused the connection');
        expect(describeSocketError(new Error('Unexpected server response: 404'))).toMatch(/404/);
        expect(describeSocketError(new Error('Unexpected server response: 502'))).toBe(
            'The server answered 502 instead of opening the connection',
        );
    });
});
