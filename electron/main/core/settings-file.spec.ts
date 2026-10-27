import { describe, expect, it } from 'vitest';
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
        expect(DEFAULT_SETTINGS.voicebanKeys).toEqual({ start: 'F8', end: 'F9' });
        expect(settings.voicebanKeys).toEqual({ start: 'F8', end: 'F9' });
    });

    it('keeps the overlay keys it wrote, none included, and repairs them key by key', () => {
        const settings = { ...DEFAULT_SETTINGS, voicebanKeys: { start: 'none', end: 'F12' } } as const;
        expect(parseSettingsFile(JSON.parse(JSON.stringify(toSettingsFile(settings, null)))).settings).toEqual(settings);
        expect(parseSettingsFile({ voicebanKeys: { start: 'Enter', end: 'F10' } }).settings.voicebanKeys).toEqual({
            start: 'F8',
            end: 'F10',
        });
        expect(parseSettingsFile({ voicebanKeys: 'F8' }).settings.voicebanKeys).toEqual({ start: 'F8', end: 'F9' });
        expect(parseSettingsFile({ voicebanKeys: { start: 'f8', end: 'F25' } }).settings.voicebanKeys).toEqual({
            start: 'F8',
            end: 'F9',
        });
    });
});
