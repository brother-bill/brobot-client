/**
 * The settings file's shape, and reading it back defensively: a hand-edited
 * or half-written `settings.json` must degrade to defaults field by field, not
 * crash a tray app nobody is watching start at sign-in.
 */

import {
    DEFAULT_SERVER_URL,
    normalizeServerUrl,
    type BanCommand,
    type PublicSettings,
} from '@brobot-client/shared';

/** Everything persisted except the secret, which is stored encrypted beside it. */
export type StoredSettings = Omit<PublicSettings, 'hasSecret'>;

export const DEFAULT_SETTINGS: StoredSettings = {
    serverUrl: DEFAULT_SERVER_URL,
    commands: { chatban: true, voiceban: true },
    safeMode: false,
    paused: false,
    // Off until first-run setup completes, then switched on once (the owner's
    // "default ON after first setup"); see ClientController.
    startWithWindows: false,
    setupComplete: false,
};

/** What is written to disk. `secret` is `safeStorage` ciphertext, base64. */
export interface SettingsFile extends StoredSettings {
    readonly version: 1;
    readonly secret: string | null;
}

export function parseSettingsFile(raw: unknown): { settings: StoredSettings; secret: string | null } {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        return { settings: DEFAULT_SETTINGS, secret: null };
    }
    const r = raw as Record<string, unknown>;
    const bool = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback);
    const url = typeof r['serverUrl'] === 'string' ? normalizeServerUrl(r['serverUrl']) : null;
    const commandsRaw =
        typeof r['commands'] === 'object' && r['commands'] !== null
            ? (r['commands'] as Record<string, unknown>)
            : {};
    const commands: Record<BanCommand, boolean> = {
        chatban: bool(commandsRaw['chatban'], DEFAULT_SETTINGS.commands.chatban),
        voiceban: bool(commandsRaw['voiceban'], DEFAULT_SETTINGS.commands.voiceban),
    };
    return {
        settings: {
            serverUrl: url?.ok ? url.url : DEFAULT_SETTINGS.serverUrl,
            commands,
            safeMode: bool(r['safeMode'], DEFAULT_SETTINGS.safeMode),
            paused: bool(r['paused'], DEFAULT_SETTINGS.paused),
            startWithWindows: bool(r['startWithWindows'], DEFAULT_SETTINGS.startWithWindows),
            setupComplete: bool(r['setupComplete'], DEFAULT_SETTINGS.setupComplete),
        },
        secret: typeof r['secret'] === 'string' && r['secret'] !== '' ? r['secret'] : null,
    };
}

export function toSettingsFile(settings: StoredSettings, secret: string | null): SettingsFile {
    return { version: 1, ...settings, secret };
}
