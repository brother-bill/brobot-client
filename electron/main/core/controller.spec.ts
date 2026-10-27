import { beforeEach, describe, expect, it } from 'vitest';
import type { ClientSnapshot, LogEntry } from '@brobot-client/shared';
import { DryRunHostControl } from '../host/dry-run-host-control';
import { FakeClock, settle } from '../testing/fake-clock';
import type { SocketHandlers } from './connection';
import { ClientController, type LoginItems, type SettingsStore } from './controller';
import { chatRelayLine, parseGameLine, parseGamePreview, type HorrorPreview, type HorrorRun } from './game-relay';
import { DEFAULT_SETTINGS, type StoredSettings } from './settings-file';
import type { GlobalShortcuts } from './shortcuts';

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

/** Windows' hotkey table, as `globalShortcut` sees it: `taken` is what other apps hold. */
class FakeShortcuts implements GlobalShortcuts {
    readonly registered = new Map<string, () => void>();
    readonly taken = new Set<string>();
    register(combo: string, onPress: () => void): boolean {
        if (this.taken.has(combo) || this.registered.has(combo)) return false;
        this.registered.set(combo, onPress);
        return true;
    }
    unregister(combo: string): void {
        this.registered.delete(combo);
    }
    press(combo: string): void {
        this.registered.get(combo)?.();
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

    let relayed: string[];
    let relayUp: boolean;
    let gameSays: ((run: HorrorRun) => void) | null;
    let gamePreviews: ((preview: HorrorPreview) => void) | null;
    let chatToGame: string[];
    let shortcuts: FakeShortcuts;
    let notifications: string[];

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
            shortcuts,
            notify: (title, body) => notifications.push(`${title} | ${body}`),
            gameRelay: {
                send: (line, onResult) => {
                    relayed.push(line);
                    onResult(relayUp);
                },
                watchRun: (onRun, onPreview) => {
                    gameSays = onRun;
                    gamePreviews = onPreview ?? null;
                },
                sendIfConnected: line => {
                    if (relayUp) chatToGame.push(line);
                    return relayUp;
                },
            },
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
        relayed = [];
        relayUp = true;
        gameSays = null;
        gamePreviews = null;
        chatToGame = [];
        shortcuts = new FakeShortcuts();
        notifications = [];
    });

    describe('key bindings', () => {
        /** Set up, started and connected. */
        const connected = (): ClientController => {
            store.secret = 's3cret';
            const controller = create();
            controller.start();
            sockets[0]?.handlers.onOpen();
            return controller;
        };

        it("listens for the old client's Ctrl+Alt+F5 / F4 / F7 once started, and sends what each one is for", () => {
            const controller = connected();
            expect([...shortcuts.registered.keys()]).toEqual(['Ctrl+Alt+F5', 'Ctrl+Alt+F4', 'Ctrl+Alt+F7']);
            expect(controller.snapshot().shortcuts.create_marker).toEqual({ state: 'active', combo: 'Ctrl+Alt+F5' });
            shortcuts.press('Ctrl+Alt+F5');
            shortcuts.press('Ctrl+Alt+F4');
            shortcuts.press('Ctrl+Alt+F7');
            expect(sockets[0]?.sent).toEqual([
                '{"type":"create_marker"}',
                '{"type":"create_prediction"}',
                '{"type":"play_ad"}',
            ]);
        });

        it("shows brobot's answer in the log and as a notification", () => {
            connected();
            shortcuts.press('Ctrl+Alt+F7');
            sockets[0]?.handlers.onMessage('{"type":"play_ad_complete","error":"not live"}');
            expect(logs.at(-1)).toMatchObject({ source: 'bot', tone: 'error', message: 'No ad break: not live' });
            expect(notifications.at(-1)).toBe('No ad break | not live');
            shortcuts.press('Ctrl+Alt+F5');
            sockets[0]?.handlers.onMessage('{"type":"create_marker_complete"}');
            expect(logs.at(-1)).toMatchObject({ tone: 'success', message: 'Stream marker created' });
        });

        it('says clearly when another app owns a combination, in the log, a notification and the snapshot', () => {
            shortcuts.taken.add('Ctrl+Alt+F4');
            const controller = connected();
            expect(controller.snapshot().shortcuts.create_prediction).toEqual({ state: 'taken', combo: 'Ctrl+Alt+F4' });
            expect(logs.some(l => l.tone === 'error' && l.message.includes('Ctrl+Alt+F4 is not working'))).toBe(true);
            expect(notifications).toEqual([
                'Prediction shortcut not working | Another app already uses Ctrl+Alt+F4. Pick another in brobot → Settings → Key bindings.',
            ]);
            // Moving it somewhere free fixes it.
            controller.updateSettings({ keyBindings: { create_prediction: 'Ctrl+Alt+F6' } });
            expect(controller.snapshot().shortcuts.create_prediction.state).toBe('active');
            expect(shortcuts.registered.has('Ctrl+Alt+F6')).toBe(true);
            expect(shortcuts.registered.has('Ctrl+Alt+F4')).toBe(false);
        });

        it('re-registers on a change, and lets go of a binding switched off', () => {
            const controller = connected();
            controller.updateSettings({ keyBindings: { create_marker: 'Ctrl+Shift+F5', play_ad: 'none' } });
            expect([...shortcuts.registered.keys()].sort()).toEqual(['Ctrl+Alt+F4', 'Ctrl+Shift+F5']);
            expect(controller.snapshot().shortcuts.play_ad).toEqual({ state: 'off', combo: 'none' });
            expect(logs.map(l => l.message)).toEqual(
                expect.arrayContaining(['Marker shortcut set to Ctrl+Shift+F5', 'Ad shortcut off']),
            );
        });

        it('refuses a duplicate, a bare letter or Enter, and saves nothing', () => {
            const controller = connected();
            const saves = store.saves;
            expect(() => controller.updateSettings({ keyBindings: { play_ad: 'F8' } })).toThrow(/already the Voiceban start key/);
            expect(() => controller.updateSettings({ keyBindings: { voiceban_end: 'Ctrl+Alt+F5' } })).toThrow(/Marker/);
            expect(() => controller.updateSettings({ keyBindings: { create_marker: 'M' } })).toThrow(/Add Ctrl or Alt/);
            expect(() => controller.updateSettings({ keyBindings: { voiceban_start: 'Ctrl+Enter' } })).toThrow(/chat ban/);
            expect(store.saves).toBe(saves);
            expect(store.settings.keyBindings).toEqual(DEFAULT_SETTINGS.keyBindings);
        });

        it('checks a combination before it is saved: errors, common defaults, and whether Windows would give it', () => {
            const controller = connected();
            expect(controller.checkBinding('create_marker', 'F9').errors).toHaveLength(1);
            expect(controller.checkBinding('create_marker', 'Ctrl+Shift+M').warnings).toEqual([
                "Ctrl+Shift+M is Discord's Toggle Mute by default, so pressing it may set that off too.",
            ]);
            shortcuts.taken.add('Ctrl+Alt+F11');
            expect(controller.checkBinding('create_marker', 'Ctrl+Alt+F11').warnings[0]).toMatch(/Another app already uses Ctrl\+Alt\+F11/);
            expect(shortcuts.registered.has('Ctrl+Alt+F12')).toBe(false);
            expect(controller.checkBinding('create_marker', 'Ctrl+Alt+F12')).toEqual({ errors: [], warnings: [] });
            // The probe let go of what it tried.
            expect(shortcuts.registered.has('Ctrl+Alt+F12')).toBe(false);
            // A voiceban key is pressed, not registered: no probe.
            expect(controller.checkBinding('voiceban_start', 'Ctrl+Alt+F11')).toEqual({ errors: [], warnings: [] });
        });

        it('lets go of the shortcuts while the window captures a key, and takes them back after', () => {
            const controller = connected();
            controller.captureKeys(true);
            expect(shortcuts.registered.size).toBe(0);
            expect(controller.snapshot().shortcuts.create_marker.state).toBe('paused');
            controller.captureKeys(false);
            expect(shortcuts.registered.size).toBe(3);
            // And by themselves when the window never says it is done.
            controller.captureKeys(true);
            clock.advance(60_000);
            expect(shortcuts.registered.size).toBe(3);
        });

        it('tests a shortcut by sending it, de-duped like a press; safe mode only logs', () => {
            const controller = connected();
            void controller.testBinding('create_marker');
            void controller.testBinding('create_marker');
            expect(sockets[0]?.sent).toEqual(['{"type":"create_marker"}']);
            expect(logs.at(-1)?.message).toBe('Test: Marker pressed again within 5 s; ignored');
            controller.updateSettings({ safeMode: true });
            void controller.testBinding('play_ad');
            expect(sockets[0]?.sent).toEqual(['{"type":"create_marker"}']);
            expect(logs.at(-1)?.message).toBe('Test: Would ask brobot for an ad break (safe mode: nothing was sent)');
        });

        it('tests a voiceban key by pressing it with the host in use, the dry run in safe mode', async () => {
            const controller = connected();
            await controller.testBinding('voiceban_start');
            expect(windowsHost.presses).toEqual(['F8']);
            controller.updateSettings({ safeMode: true, keyBindings: { voiceban_end: 'Ctrl+F9' } });
            await controller.testBinding('voiceban_end');
            expect(windowsHost.presses).toEqual(['F8']);
            expect(logs.at(-1)?.message).toBe('Test: Would press Ctrl+F9 (overlay off) (safe mode: nothing was pressed)');
            controller.updateSettings({ keyBindings: { voiceban_end: 'none' } });
            await controller.testBinding('voiceban_end');
            expect(logs.at(-1)?.message).toBe('Test: Voiceban end is off, so there is no key to press');
        });

        it('lets go of every shortcut on quit', () => {
            const controller = connected();
            controller.shutdown();
            expect(shortcuts.registered.size).toBe(0);
        });
    });

    it('hands a horror redemption to the game relay as one JSON line, and logs whether the game took it', () => {
        const controller = create();
        controller.start();
        controller.setSecret('s3cret');
        sockets[0]?.handlers.onOpen();
        sockets[0]?.handlers.onMessage('{"type":"horror","effect":"freeze","user":"Ash"}');
        expect(relayed).toEqual(['{"event":"freeze","user":"Ash","source":"redeem"}\n']);
        expect(logs.at(-1)).toMatchObject({ source: 'bot', tone: 'success' });

        relayUp = false;
        sockets[0]?.handlers.onMessage('{"type":"horror","effect":"boo","user":"Misty"}');
        expect(logs.at(-1)).toMatchObject({ tone: 'warning' });
        expect(logs.at(-1)?.message).toContain('not running');
    });

    it('passes forwarded chat lines to the game only while it runs, logging once per stretch', () => {
        const controller = create();
        controller.start();
        controller.setSecret('s3cret');
        sockets[0]?.handlers.onOpen();
        sockets[0]?.handlers.onMessage('{"type":"horror_chat","user":"Kevin","text":"!door left"}');
        sockets[0]?.handlers.onMessage('{"type":"horror_chat","user":"Bob","text":"2"}');
        expect(chatToGame).toEqual(['{"type":"chat","user":"Kevin","text":"!door left"}\n', '{"type":"chat","user":"Bob","text":"2"}\n']);
        expect(logs.filter(l => l.message.includes('Passing Twitch chat')).length).toBe(1);
        relayUp = false;
        sockets[0]?.handlers.onMessage('{"type":"horror_chat","user":"Kevin","text":"!help"}');
        expect(chatToGame.length).toBe(2);
        expect(relayed).toEqual([]);   // never queued like a redemption
    });

    it("passes the game's dream preview on to brobot", () => {
        const controller = create();
        controller.start();
        controller.setSecret('s3cret');
        sockets[0]?.handlers.onOpen();
        gamePreviews?.({ dream: 'freddy', name: 'Night Shift' });
        expect(JSON.parse(sockets[0]?.sent.at(-1) ?? '{}')).toEqual({ type: 'horror_preview', dream: 'freddy', name: 'Night Shift' });
    });

    it('reads preview lines and writes chat lines in the game format', () => {
        expect(parseGamePreview('{"type":"preview","dream":"freddy","name":"Night Shift"}')).toEqual({ dream: 'freddy', name: 'Night Shift' });
        expect(parseGamePreview('{"type":"preview"}')).toBeNull();
        expect(parseGamePreview('{"type":"run","state":"start"}')).toBeNull();
        expect(chatRelayLine({ type: 'horror_chat', user: 'A "b"', text: 'x' })).toBe('{"type":"chat","user":"A \\"b\\"","text":"x"}\n');
    });

    it("tells brobot the horror game's run state, and again whenever brobot reconnects", () => {
        const controller = create();
        controller.start();
        controller.setSecret('s3cret');
        sockets[0]?.handlers.onOpen();
        expect(sockets[0]?.sent).toEqual([]);   // no run: nothing to say (brobot hides the rewards by default)
        gameSays?.({ live: true, dream: 'Night Shift' });
        expect(JSON.parse(sockets[0]?.sent.at(-1) ?? '{}')).toEqual({ type: 'horror_run', live: true, dream: 'Night Shift' });
        expect(logs.at(-1)?.message).toContain('started a run');

        sockets[0]?.handlers.onClose(1006, 'gone');
        clock.advance(60_000);
        const again = sockets.at(-1);
        again?.handlers.onOpen();
        expect(JSON.parse(again?.sent.at(-1) ?? '{}')).toEqual({ type: 'horror_run', live: true, dream: 'Night Shift' });

        gameSays?.({ live: false, dream: '' });
        expect(JSON.parse(again?.sent.at(-1) ?? '{}')).toEqual({ type: 'horror_run', live: false });
    });

    it("reads the game's run lines", () => {
        expect(parseGameLine('{"type":"run","state":"start","dream":"The Woods"}')).toEqual({ live: true, dream: 'The Woods' });
        expect(parseGameLine('{"type":"run","state":"end","dream":""}')).toEqual({ live: false, dream: '' });
        expect(parseGameLine('{"type":"run","state":"maybe"}')).toBeNull();
        expect(parseGameLine('{"event":"boo"}')).toBeNull();
        expect(parseGameLine('not json')).toBeNull();
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

    it('saves the overlay keys one at a time, and uses them for the next voiceban', async () => {
        const controller = create();
        controller.updateSettings({ keyBindings: { voiceban_start: 'none' } });
        controller.updateSettings({ keyBindings: { voiceban_end: 'F10' } });
        expect(store.settings.keyBindings).toMatchObject({ voiceban_start: 'none', voiceban_end: 'F10' });
        expect(controller.snapshot().settings.keyBindings).toMatchObject({ voiceban_start: 'none', voiceban_end: 'F10' });
        const messages = logs.map(l => l.message);
        expect(messages).toContain('Nothing is pressed when a voiceban starts');
        expect(messages).toContain('F10 is pressed when a voiceban ends');

        controller.test('voiceban');
        await settle();
        expect(windowsHost.calls[0]?.keys).toEqual({ start: 'none', end: 'F10' });
    });

    it('releases a voiceban on quit, which presses the end key', async () => {
        store.secret = 's3cret';
        const controller = create();
        controller.start();
        sockets[0]!.handlers.onOpen();
        sockets[0]!.handlers.onMessage('{"type":"voiceban","durationMs":30000}');
        await settle();
        expect(logs.map(l => l.message)).toContain('Would press F8 (overlay on) (safe mode: nothing was pressed)');
        controller.shutdown();
        await settle();
        expect(windowsHost.calls[0]?.released).toBe(true);
        const messages = logs.map(l => l.message);
        expect(messages.slice(messages.indexOf('Microphone unmuted (released early)'))).toEqual([
            'Microphone unmuted (released early)',
            'Would press F9 (overlay off) (safe mode: nothing was pressed)',
            'Could not tell brobot the voiceban is over: not connected',
        ]);
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
