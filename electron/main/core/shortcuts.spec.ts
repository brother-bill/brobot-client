import { beforeEach, describe, expect, it } from 'vitest';
import { CAPTURE_TIMEOUT_MS, DEFAULT_KEY_BINDINGS, type HotkeyEvent } from '@brobot-client/shared';
import { FakeClock } from '../testing/fake-clock';
import {
    SHORTCUT_REPEAT_MS,
    SHORTCUT_REPLY_TIMEOUT_MS,
    ShortcutManager,
    type GlobalShortcuts,
} from './shortcuts';

const BINDINGS = {
    create_marker: DEFAULT_KEY_BINDINGS.create_marker,
    create_prediction: DEFAULT_KEY_BINDINGS.create_prediction,
    play_ad: DEFAULT_KEY_BINDINGS.play_ad,
};

describe('ShortcutManager', () => {
    let clock: FakeClock;
    let registered: Map<string, () => void>;
    let taken: Set<string>;
    let sent: HotkeyEvent[];
    let connected: boolean;
    let safeMode: boolean;
    let logs: { tone: string; message: string }[];
    let notifications: string[];
    let changes: number;
    let manager: ShortcutManager;

    beforeEach(() => {
        clock = new FakeClock();
        registered = new Map();
        taken = new Set();
        sent = [];
        connected = true;
        safeMode = false;
        logs = [];
        notifications = [];
        changes = 0;
        const shortcuts: GlobalShortcuts = {
            register: (combo, onPress) => {
                // Windows refuses a combination already registered, ours included.
                if (taken.has(combo) || registered.has(combo)) return false;
                registered.set(combo, onPress);
                return true;
            },
            unregister: combo => void registered.delete(combo),
        };
        manager = new ShortcutManager({
            clock,
            shortcuts,
            send: event => {
                if (connected) sent.push(event);
                return connected;
            },
            safeMode: () => safeMode,
            log: (_source, tone, message) => logs.push({ tone, message }),
            notify: (title, body) => notifications.push(`${title} | ${body}`),
            onChange: () => changes++,
        });
    });

    const press = (combo: string): void => registered.get(combo)?.();

    it('drops a repeat inside 5 s, as the old client did, and takes the next one after', () => {
        manager.apply(BINDINGS);
        press('Ctrl+Alt+F5');
        clock.advance(SHORTCUT_REPEAT_MS - 1);
        press('Ctrl+Alt+F5');
        expect(sent).toEqual([{ type: 'create_marker' }]);
        expect(logs.at(-1)?.message).toBe('Marker pressed again within 5 s; ignored');
        // Each shortcut has its own window.
        press('Ctrl+Alt+F7');
        clock.advance(1);
        press('Ctrl+Alt+F5');
        expect(sent).toEqual([{ type: 'create_marker' }, { type: 'play_ad' }, { type: 'create_marker' }]);
    });

    it('says so when brobot never answers, and not when it does', () => {
        manager.apply(BINDINGS);
        press('Ctrl+Alt+F4');
        clock.advance(SHORTCUT_REPLY_TIMEOUT_MS);
        expect(logs.at(-1)).toEqual({ tone: 'warning', message: 'brobot did not answer about the prediction within 15 s' });

        press('Ctrl+Alt+F5');
        manager.complete({ type: 'create_marker_complete' });
        clock.advance(SHORTCUT_REPLY_TIMEOUT_MS);
        expect(logs.at(-1)).toEqual({ tone: 'success', message: 'Stream marker created' });
        expect(notifications.at(-1)).toBe('Stream marker created | brobot says Twitch did it.');
    });

    it('tells the streamer a press went nowhere while disconnected, or in safe mode', () => {
        manager.apply(BINDINGS);
        connected = false;
        press('Ctrl+Alt+F5');
        expect(logs.at(-1)).toEqual({ tone: 'warning', message: 'Marker not sent: brobot is not connected' });
        expect(notifications.at(-1)).toBe('Marker: not sent | brobot is not connected, so nothing reached Twitch.');

        connected = true;
        safeMode = true;
        press('Ctrl+Alt+F7');
        expect(sent).toEqual([]);
        expect(logs.at(-1)?.message).toBe('Would ask brobot for an ad break (safe mode: nothing was sent)');
        expect(clock.pending).toBe(0);
    });

    it('reports a combination another app holds once, not on every save, and again for a new one', () => {
        taken.add('Ctrl+Alt+F5');
        manager.apply(BINDINGS);
        manager.apply(BINDINGS);
        manager.suspend(true);
        manager.suspend(false);
        expect(manager.status.create_marker).toEqual({ state: 'taken', combo: 'Ctrl+Alt+F5' });
        expect(notifications).toHaveLength(1);
        expect(logs.filter(l => l.tone === 'error')).toHaveLength(1);

        taken.add('Ctrl+Alt+F6');
        manager.apply({ ...BINDINGS, create_marker: 'Ctrl+Alt+F6' });
        expect(notifications).toHaveLength(2);

        // The other app let go: the next save picks it up, and says so.
        taken.clear();
        manager.apply({ ...BINDINGS, create_marker: 'Ctrl+Alt+F6' });
        expect(manager.status.create_marker.state).toBe('active');
        expect(logs.at(-1)).toEqual({ tone: 'success', message: 'The Marker shortcut Ctrl+Alt+F6 is working now' });
    });

    it('touches only what changed, and reports status changes', () => {
        manager.apply(BINDINGS);
        const before = changes;
        const markerPress = registered.get('Ctrl+Alt+F5');
        manager.apply({ ...BINDINGS, play_ad: 'none' });
        expect(registered.get('Ctrl+Alt+F5')).toBe(markerPress);
        expect(registered.has('Ctrl+Alt+F7')).toBe(false);
        expect(manager.status.play_ad).toEqual({ state: 'off', combo: 'none' });
        expect(changes).toBe(before + 1);
    });

    it('lets two shortcuts swap combinations in one save', () => {
        manager.apply(BINDINGS);
        manager.apply({ ...BINDINGS, create_marker: 'Ctrl+Alt+F4', create_prediction: 'Ctrl+Alt+F5' });
        expect(manager.status.create_marker).toEqual({ state: 'active', combo: 'Ctrl+Alt+F4' });
        expect(manager.status.create_prediction).toEqual({ state: 'active', combo: 'Ctrl+Alt+F5' });
        expect(notifications).toEqual([]);
        press('Ctrl+Alt+F4');
        expect(sent).toEqual([{ type: 'create_marker' }]);
    });

    it('pauses for a capture and comes back by itself if the window never finishes', () => {
        manager.apply({ ...BINDINGS, play_ad: 'none' });
        manager.suspend(true);
        expect(registered.size).toBe(0);
        expect(manager.status.create_marker.state).toBe('paused');
        expect(manager.status.play_ad.state).toBe('off');
        clock.advance(CAPTURE_TIMEOUT_MS);
        expect([...registered.keys()]).toEqual(['Ctrl+Alt+F5', 'Ctrl+Alt+F4']);
        expect(logs.at(-1)?.message).toBe('Shortcuts are listening again (the key change was not finished)');
    });

    it('probes a combination by registering it and letting go', () => {
        manager.apply(BINDINGS);
        expect(manager.probe('create_marker', 'Ctrl+Alt+F11')).toBeNull();
        expect(registered.has('Ctrl+Alt+F11')).toBe(false);
        taken.add('Ctrl+Alt+F12');
        expect(manager.probe('play_ad', 'Ctrl+Alt+F12')).toMatch(/^Another app already uses Ctrl\+Alt\+F12/);
        // Its own combination is not "taken".
        expect(manager.probe('create_marker', 'Ctrl+Alt+F5')).toBeNull();
        expect(registered.has('Ctrl+Alt+F5')).toBe(true);
    });

    it('lets go of everything on stop, timers included', () => {
        manager.apply(BINDINGS);
        press('Ctrl+Alt+F5');
        manager.suspend(true);
        manager.stop();
        expect(registered.size).toBe(0);
        expect(clock.pending).toBe(0);
    });
});
