/**
 * What the streamer configures, and the rules for the one field they type.
 *
 * The secret is not in here. It is written once through `settings.setSecret`,
 * encrypted with Electron `safeStorage` (DPAPI on Windows), and never read back
 * into the renderer: the window learns only whether one is stored.
 */

import { STREAMER_SOCKET_PATH } from './streamer-events';
import type { BanCommand } from './server-events';

export const DEFAULT_SERVER_URL = `wss://admin.brobot.live${STREAMER_SOCKET_PATH}`;

/** The keys a voiceban may press: the function keys Windows has (F1–F24). */
export const OVERLAY_KEYS = [
    'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
    'F13', 'F14', 'F15', 'F16', 'F17', 'F18', 'F19', 'F20', 'F21', 'F22', 'F23', 'F24',
] as const;

export type OverlayKey = (typeof OVERLAY_KEYS)[number];

/** A key to press, or `'none'` to press nothing. */
export type OverlayKeySetting = OverlayKey | 'none';

/**
 * The keys a voiceban presses as it starts and as it ends. Streamlabs Desktop
 * has them bound as global hotkeys that show and hide the voiceban overlay;
 * the pre-rewrite client pressed F8 and F9 the same way.
 */
export interface VoicebanKeys {
    readonly start: OverlayKeySetting;
    readonly end: OverlayKeySetting;
}

export const DEFAULT_VOICEBAN_KEYS: VoicebanKeys = { start: 'F8', end: 'F9' };

export function isOverlayKeySetting(value: unknown): value is OverlayKeySetting {
    return value === 'none' || (OVERLAY_KEYS as readonly unknown[]).includes(value);
}

/** Settings as the renderer sees them. */
export interface PublicSettings {
    /** The full socket URL, `wss://…/api/ashketchum`. */
    readonly serverUrl: string;
    /** Whether a secret is stored. The secret itself never leaves the main process. */
    readonly hasSecret: boolean;
    /** Per-command switch: off means "tell brobot no" instead of doing it. */
    readonly commands: Readonly<Record<BanCommand, boolean>>;
    /** The overlay hotkeys a voiceban presses (default F8 on, F9 off). */
    readonly voicebanKeys: VoicebanKeys;
    /**
     * Safe mode: every command, real or test, goes to the dry-run driver. The
     * log shows what WOULD have happened; the keyboard and mic are untouched.
     */
    readonly safeMode: boolean;
    /** Pause: stay connected, but decline every command until resumed. */
    readonly paused: boolean;
    /** Launch at Windows sign-in, straight to the tray. */
    readonly startWithWindows: boolean;
    /**
     * Whether first-run setup (a server URL and a secret) has been completed.
     * Start-with-Windows switches itself on the first time this becomes true.
     */
    readonly setupComplete: boolean;
}

/** What the renderer may change in one call. The secret has its own operation. */
export type SettingsPatch = Partial<
    Pick<PublicSettings, 'serverUrl' | 'safeMode' | 'paused' | 'startWithWindows'>
> & {
    readonly commands?: Partial<Record<BanCommand, boolean>>;
    readonly voicebanKeys?: Partial<VoicebanKeys>;
};

export type ServerUrlResult =
    | { readonly ok: true; readonly url: string }
    | { readonly ok: false; readonly error: string };

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Turns what the streamer typed into the socket URL, or says why it cannot.
 *
 * Accepts the forms people actually paste — `admin.brobot.live`,
 * `https://admin.brobot.live`, the full `wss://…/api/ashketchum` — and fills
 * in the socket path when only a host is given.
 *
 * Plain `ws://` is refused except to this machine: the secret travels in the
 * upgrade headers, and over an unencrypted socket anyone on the café Wi-Fi
 * could read it and lock the streamer's keyboard.
 */
export function normalizeServerUrl(input: string): ServerUrlResult {
    const trimmed = input.trim();
    if (trimmed === '') {
        return { ok: false, error: 'Enter the brobot server address.' };
    }
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `wss://${trimmed}`;
    let url: URL;
    try {
        url = new URL(withScheme);
    } catch {
        return { ok: false, error: 'That is not a valid address.' };
    }
    switch (url.protocol) {
        case 'https:':
            url.protocol = 'wss:';
            break;
        case 'http:':
            url.protocol = 'ws:';
            break;
        case 'wss:':
        case 'ws:':
            break;
        default:
            return { ok: false, error: 'The address must start with wss:// or https://.' };
    }
    if (url.protocol === 'ws:' && !LOOPBACK_HOSTS.has(url.hostname)) {
        return {
            ok: false,
            error: 'Use wss:// (encrypted). Plain ws:// is only allowed to this computer.',
        };
    }
    if (url.username !== '' || url.password !== '') {
        return { ok: false, error: 'Put the secret in the secret field, not in the address.' };
    }
    if (url.pathname === '' || url.pathname === '/') {
        url.pathname = STREAMER_SOCKET_PATH;
    }
    url.hash = '';
    return { ok: true, url: url.toString() };
}

/** The host part of a socket URL, for "Connected to admin.brobot.live". */
export function serverHost(serverUrl: string): string {
    try {
        return new URL(serverUrl).host;
    } catch {
        return serverUrl;
    }
}
