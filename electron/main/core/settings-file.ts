/**
 * The settings file's shape, and reading it back defensively: a hand-edited
 * or half-written `settings.json` must degrade to defaults field by field, not
 * crash a tray app nobody is watching start at sign-in.
 */

import {
    DEFAULT_KEY_BINDINGS,
    DEFAULT_SERVER_URL,
    PRESSED_BINDINGS,
    STREAMER_HOTKEYS,
    isPressedBinding,
    normalizeComboSetting,
    normalizeServerUrl,
    refusalOf,
    type BanCommand,
    type KeyBindingId,
    type KeyBindings,
    type KeyComboSetting,
    type PublicSettings,
} from '@brobot-client/shared';

/** Everything persisted except the secret, which is stored encrypted beside it. */
export type StoredSettings = Omit<PublicSettings, 'hasSecret'>;

export const DEFAULT_SETTINGS: StoredSettings = {
    serverUrl: DEFAULT_SERVER_URL,
    commands: { chatban: true, voiceban: true },
    keyBindings: DEFAULT_KEY_BINDINGS,
    safeMode: false,
    paused: false,
    // Off until first-run setup completes, then switched on once (the owner's
    // "default ON after first setup"); see ClientController.
    startWithWindows: false,
    setupComplete: false,
};

/**
 * The file's format. 1 (up to 1.2.1) kept only the voiceban keys, as
 * `voicebanKeys: { start, end }`; 2 (1.2.2) keeps all five key bindings as
 * `keyBindings`. A file with no version is a 1.
 */
export const SETTINGS_FILE_VERSION = 2;

/** What is written to disk. `secret` is `safeStorage` ciphertext, base64. */
export interface SettingsFile extends StoredSettings {
    readonly version: typeof SETTINGS_FILE_VERSION;
    readonly secret: string | null;
}

function record(value: unknown): Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** A binding as stored, or null when it is not one this app would have saved. */
function storedCombo(value: unknown): KeyComboSetting | null {
    const combo = normalizeComboSetting(value);
    return combo === null || (combo !== 'none' && refusalOf(combo) !== null) ? null : combo;
}

/**
 * The key bindings, from either format, each one checked on its own and
 * falling back to its default. A version 1 file only had the voiceban keys
 * (F1–F24 or none); its shortcuts get the pre-rewrite client's
 * Ctrl+Alt+F5 / F4 / F7.
 *
 * A duplicate (hand-edited, or a default that collides with a key moved onto
 * it) is switched off rather than kept: two bindings on one combination would
 * fire a shortcut every time a voiceban pressed its key. The streamer's own
 * values are placed before any default, voiceban keys first, so those are the
 * ones that stay. The two voiceban keys may be the same key (1.2.1 allowed it:
 * a hotkey that toggles the overlay).
 */
function readKeyBindings(raw: Record<string, unknown>, version: number): KeyBindings {
    const v1Keys = record(raw['voicebanKeys']);
    const source: Record<string, unknown> =
        version >= 2 ? record(raw['keyBindings']) : { voiceban_start: v1Keys['start'], voiceban_end: v1Keys['end'] };
    const bindings: Record<KeyBindingId, KeyComboSetting> = { ...DEFAULT_KEY_BINDINGS };
    const order = [...PRESSED_BINDINGS, ...STREAMER_HOTKEYS];
    const assigned = new Map<KeyBindingId, KeyComboSetting>();
    const collides = (id: KeyBindingId, combo: KeyComboSetting): boolean =>
        combo !== 'none' && [...assigned].some(([other, theirs]) => theirs === combo && !(isPressedBinding(id) && isPressedBinding(other)));
    // The streamer's own values first, so a default never pushes one of theirs off.
    for (const pass of ['stored', 'default'] as const) {
        for (const id of order) {
            if (assigned.has(id)) continue;
            const stored = storedCombo(source[id]);
            if (pass === 'stored' && stored === null) continue;
            const combo = stored ?? DEFAULT_KEY_BINDINGS[id];
            assigned.set(id, collides(id, combo) ? 'none' : combo);
        }
    }
    for (const [id, combo] of assigned) bindings[id] = combo;
    return bindings;
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
    const version = typeof r['version'] === 'number' ? r['version'] : 1;
    return {
        settings: {
            serverUrl: url?.ok ? url.url : DEFAULT_SETTINGS.serverUrl,
            commands,
            // Files written before 1.2.1 have no keys at all: they get F8/F9,
            // which is what the pre-rewrite client pressed.
            keyBindings: readKeyBindings(r, version),
            safeMode: bool(r['safeMode'], DEFAULT_SETTINGS.safeMode),
            paused: bool(r['paused'], DEFAULT_SETTINGS.paused),
            startWithWindows: bool(r['startWithWindows'], DEFAULT_SETTINGS.startWithWindows),
            setupComplete: bool(r['setupComplete'], DEFAULT_SETTINGS.setupComplete),
        },
        secret: typeof r['secret'] === 'string' && r['secret'] !== '' ? r['secret'] : null,
    };
}

export function toSettingsFile(settings: StoredSettings, secret: string | null): SettingsFile {
    return { version: SETTINGS_FILE_VERSION, ...settings, secret };
}
