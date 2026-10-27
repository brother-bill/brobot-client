import { describe, expect, it } from 'vitest';
import { DEFAULT_KEY_BINDINGS } from '@brobot-client/shared';
import { DEFAULT_SETTINGS, parseSettingsFile, toSettingsFile } from './settings-file';

describe('parseSettingsFile', () => {
    it('round-trips what it writes', () => {
        const settings = { ...DEFAULT_SETTINGS, paused: true, commands: { chatban: false, voiceban: true } };
        expect(parseSettingsFile(JSON.parse(JSON.stringify(toSettingsFile(settings, 'Y2lwaGVy'))))).toEqual({
            settings,
            secret: 'Y2lwaGVy',
        });
    });

    it('falls back to defaults for a missing or unreadable file', () => {
        expect(parseSettingsFile(null)).toEqual({ settings: DEFAULT_SETTINGS, secret: null });
        expect(parseSettingsFile('garbage')).toEqual({ settings: DEFAULT_SETTINGS, secret: null });
        expect(parseSettingsFile([])).toEqual({ settings: DEFAULT_SETTINGS, secret: null });
    });

    it('repairs a hand-edited file field by field', () => {
        const { settings, secret } = parseSettingsFile({
            serverUrl: 'ws://not-allowed.example',
            commands: { chatban: 'yes' },
            safeMode: true,
            secret: '',
        });
        expect(settings.serverUrl).toBe(DEFAULT_SETTINGS.serverUrl);
        expect(settings.commands).toEqual(DEFAULT_SETTINGS.commands);
        expect(settings.safeMode).toBe(true);
        expect(secret).toBeNull();
    });

    it('gives a file from before the overlay keys F8 and F9, as the old client pressed', () => {
        const { settings } = parseSettingsFile({ version: 1, serverUrl: 'wss://admin.brobot.live/api/ashketchum' });
        expect(DEFAULT_SETTINGS.keyBindings).toMatchObject({ voiceban_start: 'F8', voiceban_end: 'F9' });
        expect(settings.keyBindings).toEqual(DEFAULT_KEY_BINDINGS);
    });

    it("migrates a 1.2.1 file's voiceban keys, and gives it the old client's shortcuts", () => {
        const { settings } = parseSettingsFile({ version: 1, voicebanKeys: { start: 'none', end: 'F12' } });
        expect(settings.keyBindings).toEqual({
            create_marker: 'Ctrl+Alt+F5',
            create_prediction: 'Ctrl+Alt+F4',
            play_ad: 'Ctrl+Alt+F7',
            voiceban_start: 'none',
            voiceban_end: 'F12',
        });
        // A version 1 file's keyBindings, if it had any, are not what it meant.
        expect(parseSettingsFile({ version: 1, keyBindings: { create_marker: 'Ctrl+M' } }).settings.keyBindings).toEqual(
            DEFAULT_KEY_BINDINGS,
        );
    });

    it("keeps a 1.2.1 toggle key (start and end the same), and a streamer's key over a default", () => {
        const keys = (voicebanKeys: unknown) => {
            const { keyBindings } = parseSettingsFile({ version: 1, voicebanKeys }).settings;
            return { start: keyBindings.voiceban_start, end: keyBindings.voiceban_end };
        };
        expect(keys({ start: 'F8', end: 'F8' })).toEqual({ start: 'F8', end: 'F8' });
        expect(keys({ start: 'bogus', end: 'F8' })).toEqual({ start: 'F8', end: 'F8' });
        // A stored shortcut keeps its key; the default it displaced is the one switched off.
        const { keyBindings } = parseSettingsFile({
            version: 2,
            keyBindings: { create_prediction: 'Ctrl+Alt+F5' },
        }).settings;
        expect(keyBindings.create_prediction).toBe('Ctrl+Alt+F5');
        expect(keyBindings.create_marker).toBe('none');
    });

    it('repairs version 1 voiceban keys key by key', () => {
        const keys = (voicebanKeys: unknown) => {
            const { keyBindings } = parseSettingsFile({ voicebanKeys }).settings;
            return { start: keyBindings.voiceban_start, end: keyBindings.voiceban_end };
        };
        expect(keys({ start: 'Enter', end: 'F10' })).toEqual({ start: 'F8', end: 'F10' });
        expect(keys('F8')).toEqual({ start: 'F8', end: 'F9' });
        expect(keys({ start: 'f8', end: 'F25' })).toEqual({ start: 'F8', end: 'F9' });
    });

    it('writes version 2 and keeps every binding it wrote, off included', () => {
        const keyBindings = {
            create_marker: 'Ctrl+Shift+F5',
            create_prediction: 'none',
            play_ad: 'Alt+num7',
            voiceban_start: 'Ctrl+F8',
            voiceban_end: 'none',
        } as const;
        const settings = { ...DEFAULT_SETTINGS, keyBindings };
        const file = JSON.parse(JSON.stringify(toSettingsFile(settings, null))) as Record<string, unknown>;
        expect(file['version']).toBe(2);
        expect(file['voicebanKeys']).toBeUndefined();
        expect(parseSettingsFile(file).settings).toEqual(settings);
    });

    it('repairs version 2 bindings one by one: unknown, refused or misspelt', () => {
        const { keyBindings } = parseSettingsFile({
            version: 2,
            keyBindings: { create_marker: 'ctrl+alt+m', create_prediction: 'A', play_ad: 'Ctrl+Enter', voiceban_start: 42 },
        }).settings;
        expect(keyBindings).toEqual({ ...DEFAULT_KEY_BINDINGS, create_marker: 'Ctrl+Alt+M' });
    });

    it('switches off a shortcut that collides with a voiceban key, so a voiceban never fires it', () => {
        const { keyBindings } = parseSettingsFile({
            version: 2,
            keyBindings: { voiceban_start: 'Ctrl+Alt+F5', create_prediction: 'Ctrl+Alt+F7' },
        }).settings;
        expect(keyBindings.voiceban_start).toBe('Ctrl+Alt+F5');
        expect(keyBindings.create_marker).toBe('none');
        expect(keyBindings.create_prediction).toBe('Ctrl+Alt+F7');
        expect(keyBindings.play_ad).toBe('none');
    });
});
