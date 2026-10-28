/**
 * The words the window uses for the app's state. Pure functions, so the
 * phrasing is tested once rather than re-derived in each template.
 */

import {
    describeCombo,
    formatDuration,
    serverHost,
    type BanCommand,
    type ConnectionStatus,
    type KeyComboSetting,
    type LogSource,
    type LogTone,
    type PressedBinding,
    type ShortcutStatus,
} from '@brobot-client/shared';
import type { LibLiveDotState } from '@singularity/ngx-ui';

export interface ConnectionView {
    readonly dot: LibLiveDotState;
    /** Short, for the header lamp: "Connected". */
    readonly label: string;
    /** One sentence with the detail: where, and when it retries. */
    readonly detail: string;
}

export function describeConnection(
    status: ConnectionStatus,
    serverUrl: string,
    configured: boolean,
    now: number,
): ConnectionView {
    const host = serverHost(serverUrl);
    switch (status.state) {
        case 'connected':
            return { dot: 'nominal', label: 'Connected', detail: `Listening to brobot at ${host}.` };
        case 'connecting':
            return { dot: 'attention', label: 'Connecting', detail: `Connecting to ${host}…` };
        case 'reconnecting': {
            const wait =
                status.nextRetryAt === null ? null : Math.max(0, Math.ceil((status.nextRetryAt - now) / 1000));
            const when = wait === null ? 'soon' : wait === 0 ? 'now' : `in ${wait} s`;
            return {
                dot: 'fault',
                label: 'Reconnecting',
                detail: `${status.lastError ?? 'Connection lost'}. Trying again ${when} (attempt ${status.attempt}).`,
            };
        }
        case 'disconnected':
            return {
                dot: 'offline',
                label: 'Not connected',
                detail: configured
                    ? 'Not connected.'
                    : 'Enter the server address and the secret in Settings to connect.',
            };
    }
}

/** The browser source Streamlabs/OBS must show for roars and quacks to play (brobot's `/twitch/<channel>/overlay`). */
export const STREAM_OVERLAY_URL = 'https://brobot.live/twitch/supahot/overlay';

export interface StreamOverlayView {
    readonly dot: LibLiveDotState;
    readonly label: string;
    /** Not connected: the window says how to fix it. */
    readonly problem: boolean;
}

/**
 * Beside the server status: whether brobot sees the stream overlay. `null` is
 * "brobot has not said" (not connected, or a brobot older than
 * `overlay_status`), which is not the same claim as "not connected".
 */
export function describeStreamOverlay(overlays: number | null): StreamOverlayView {
    if (overlays === null) return { dot: 'idle', label: 'Overlay: unknown', problem: false };
    if (overlays > 0) return { dot: 'nominal', label: 'Overlay: connected', problem: false };
    return { dot: 'fault', label: 'Overlay: not connected — roars and quacks will be refunded', problem: true };
}

export const COMMAND_COPY: Readonly<Record<BanCommand, { title: string; effect: string; active: string }>> = {
    chatban: {
        title: 'Chat ban',
        effect: 'Blocks your Enter key, so you cannot send chat messages.',
        active: 'Enter key blocked',
    },
    voiceban: {
        title: 'Voice ban',
        effect: 'Mutes your default microphone in Windows.',
        active: 'Microphone muted',
    },
};

/** "4:05" — a countdown, never negative. */
export function formatCountdown(ms: number): string {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

export function formatAgo(ms: number): string {
    return ms < 1500 ? 'just now' : `${formatDuration(ms)} ago`;
}

export const SOURCE_LABEL: Readonly<Record<LogSource, string>> = {
    bot: 'brobot',
    host: 'This PC',
    connection: 'Connection',
    app: 'App',
};

/** Spoken before the message, so tone is never carried by colour alone. */
export const TONE_LABEL: Readonly<Record<LogTone, string>> = {
    info: '',
    success: 'Done:',
    warning: 'Warning:',
    error: 'Error:',
};

/** Under a shortcut: whether it is listening, in words. */
export function describeShortcut(status: ShortcutStatus): { readonly text: string; readonly problem: boolean } {
    switch (status.state) {
        case 'active':
            return { text: 'Listening: works in any app or game.', problem: false };
        case 'off':
            return { text: 'Off.', problem: false };
        case 'paused':
            return { text: 'Paused while you pick a new key.', problem: false };
        case 'taken':
            return {
                text: `Not working: another app already uses ${describeCombo(status.combo)}, so Windows will not give it to brobot. Change it, or free it in that app.`,
                problem: true,
            };
    }
}

/** Under a voiceban key, always: what Streamlabs/OBS has to do with it. */
export function pressedReminder(binding: PressedBinding, combo: KeyComboSetting): string {
    const moment = binding === 'voiceban_start' ? 'starts' : 'ends';
    if (combo === 'none') return `Off: brobot presses nothing as a voiceban ${moment}.`;
    const action = binding === 'voiceban_start' ? 'show' : 'hide';
    return `Streamlabs/OBS must have ${describeCombo(combo)} bound to ${action} the voiceban overlay.`;
}

/** Before a voiceban key changes: the stream software has to change with it. */
export function overlayNotice(binding: PressedBinding, combo: KeyComboSetting): string {
    if (combo === 'none') {
        const moment = binding === 'voiceban_start' ? 'starts' : 'ends';
        return (
            `brobot will stop pressing a key as a voiceban ${moment}. If Streamlabs/OBS switches the overlay ` +
            'with that key, the overlay will stop switching.'
        );
    }
    return (
        `Streamlabs/OBS must have ${describeCombo(combo)} bound to the overlay. Update the hotkey in ` +
        'Streamlabs → Settings → Hotkeys (or OBS → Settings → Hotkeys) or the overlay will stop switching.'
    );
}
