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
});
