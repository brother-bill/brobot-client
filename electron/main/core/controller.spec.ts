import { beforeEach, describe, expect, it } from 'vitest';
import type { ClientSnapshot, LogEntry } from '@brobot-client/shared';
import { DryRunHostControl } from '../host/dry-run-host-control';
import { FakeClock, settle } from '../testing/fake-clock';
import type { SocketHandlers } from './connection';
import { ClientController, type LoginItems, type SettingsStore } from './controller';
import { DEFAULT_SETTINGS, type StoredSettings } from './settings-file';

class MemoryStore implements SettingsStore {
    secureStorageAvailable = true;
    settings: StoredSettings = DEFAULT_SETTINGS;
    secret: string | null = null;
    saves = 0;
    load(): StoredSettings {
        return this.settings;
    }
    save(settings: StoredSettings): void {
        this.settings = settings;
        this.saves++;
    }
    readSecret(): string | null {
        return this.secret;
    }
    writeSecret(secret: string | null): void {
        this.secret = secret;
    }
}

interface Socket {
    url: string;
    secret: string;
    handlers: SocketHandlers;
    sent: string[];
    terminated: boolean;
}

describe('ClientController', () => {
    let clock: FakeClock;
    let store: MemoryStore;
    let sockets: Socket[];
    let windowsHost: DryRunHostControl;
    let loginCalls: boolean[];
    let snapshots: ClientSnapshot[];
    let logs: LogEntry[];

    const create = (options: { windows?: boolean; loginSupported?: boolean } = {}): ClientController => {
        const loginItems: LoginItems = {
            supported: options.loginSupported ?? true,
            set: enabled => loginCalls.push(enabled),
        };
        return new ClientController({
            clock,
            store,
            windowsHost: options.windows === false ? null : windowsHost,
            platform: options.windows === false ? 'linux' : 'win32',
            loginItems,
            version: '1.0.0',
            random: () => 0,
            socketFactory: (url, secret, handlers) => {
                const socket: Socket = { url, secret, handlers, sent: [], terminated: false };
                sockets.push(socket);
                return {
                    send: text => socket.sent.push(text),
                    terminate: () => {
                        socket.terminated = true;
                    },
                };
            },
            emitSnapshot: snapshot => snapshots.push(snapshot),
            emitLog: entry => logs.push(entry),
        });
    };

    beforeEach(() => {
        clock = new FakeClock();
        store = new MemoryStore();
        sockets = [];
        // Stands in for the Windows driver: the specs only need to see WHICH
        // driver the controller picked.
        windowsHost = new DryRunHostControl(clock);
        loginCalls = [];
        snapshots = [];
        logs = [];
    });

    it('waits for a secret before connecting', () => {
        const controller = create();
        controller.start();
        expect(sockets).toHaveLength(0);
        expect(controller.snapshot().settings).toMatchObject({ hasSecret: false, setupComplete: false });
    });

    it('completes first-run setup once: connects, and turns start-with-Windows on', () => {
        const controller = create();
        controller.start();
        const snapshot = controller.setSecret('  s3cret  ');

        expect(store.secret).toBe('s3cret');
        expect(sockets).toHaveLength(1);
        expect(sockets[0]).toMatchObject({ url: DEFAULT_SETTINGS.serverUrl, secret: 's3cret' });
        expect(snapshot.settings).toMatchObject({ hasSecret: true, setupComplete: true, startWithWindows: true });
        expect(loginCalls).toEqual([true]);

        // Turning it off afterwards sticks; a new secret does not turn it back on.
        controller.updateSettings({ startWithWindows: false });
        controller.setSecret('rotated');
        expect(loginCalls).toEqual([true, false]);
        expect(store.settings.startWithWindows).toBe(false);
        expect(sockets.at(-1)?.secret).toBe('rotated');
    });

    it('does not register a development build to start with Windows', () => {
        const controller = create({ loginSupported: false });
        controller.setSecret('s3cret');
        expect(loginCalls).toEqual([]);
        expect(logs.map(l => l.message)).toContain(
            'Start with Windows applies to the installed app, not a development run',
        );
    });

    it('runs a ban from the socket through the host and answers on the socket', async () => {
        store.secret = 's3cret';
        store.settings = { ...DEFAULT_SETTINGS, setupComplete: true };
        const controller = create();
        controller.start();
        const socket = sockets[0]!;
        socket.handlers.onOpen();
        socket.handlers.onMessage('{"type":"chatban","durationMs":60000}');
        await settle();

        expect(windowsHost.calls).toMatchObject([{ kind: 'block-enter', durationMs: 60000 }]);
        expect(controller.snapshot().active).toHaveLength(1);
        // brobot pings every 15 s; without them the heartbeat would drop the link first.
        for (let elapsed = 0; elapsed < 60_000; elapsed += 15_000) {
            clock.advance(15_000);
            socket.handlers.onMessage(`{"type":"ping","sentAt":${clock.now()}}`);
        }
        await settle();
        expect(socket.sent.filter(frame => !frame.includes('pong'))).toEqual(['{"type":"chatban_complete"}']);
        expect(controller.snapshot().active).toHaveLength(0);
    });

    it('uses the dry run in safe mode, and says why', async () => {
        store.secret = 's3cret';
        const controller = create();
        controller.updateSettings({ safeMode: true });
        expect(controller.snapshot().host).toEqual({ kind: 'dry-run', reason: 'safe mode is on' });
        controller.test('voiceban');
        await settle();
        expect(windowsHost.calls).toHaveLength(0);
        expect(controller.snapshot().active[0]).toMatchObject({ command: 'voiceban', test: true, dryRun: true });
    });

    it('uses the dry run off Windows', () => {
        const controller = create({ windows: false });
        expect(controller.snapshot().host).toEqual({
            kind: 'dry-run',
            reason: 'host control needs Windows; this is linux',
        });
    });

    it('normalises the server URL, and refuses a bad one without saving', () => {
        store.secret = 's3cret';
        const controller = create();
        controller.start();
        const saves = store.saves;
        expect(() => controller.updateSettings({ serverUrl: 'ws://evil.example' })).toThrow(/wss:\/\//);
        expect(store.saves).toBe(saves);

        controller.updateSettings({ serverUrl: 'brobot.test' });
        expect(store.settings.serverUrl).toBe('wss://brobot.test/api/ashketchum');
        expect(sockets.at(-1)?.url).toBe('wss://brobot.test/api/ashketchum');
    });

    it('logs what changed in words', () => {
        const controller = create();
        controller.updateSettings({ paused: true, commands: { voiceban: false } });
        const messages = logs.map(l => l.message);
        expect(messages).toContain('Commands paused');
        expect(messages).toContain('voiceban disabled');
    });

    it('pushes a snapshot on every change, and stops cleanly', () => {
        store.secret = 's3cret';
        const controller = create();
        const seen: ClientSnapshot[] = [];
        const off = controller.onChange(s => seen.push(s));
        controller.start();
        sockets[0]!.handlers.onOpen();
        expect(seen.at(-1)?.connection.state).toBe('connected');
        expect(snapshots.at(-1)?.connection.state).toBe('connected');

        off();
        controller.shutdown();
        expect(sockets[0]!.terminated).toBe(true);
        expect(controller.snapshot().connection.state).toBe('disconnected');
        expect(seen.at(-1)?.connection.state).toBe('connected');
    });

    it('refuses to reconnect with nothing configured, and says what is missing', () => {
        const controller = create();
        controller.reconnect();
        expect(sockets).toHaveLength(0);
        expect(logs.at(-1)?.message).toBe('Cannot connect yet: set the server URL and the secret first');
    });
});
