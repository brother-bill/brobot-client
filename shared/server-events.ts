/**
 * The client's half of the `/api/ashketchum` contract: reading what brobot
 * sends. `streamer-events.ts` is the server's file, copied verbatim, and only
 * ships a parser for the other direction; this is its mirror image.
 */

import {
    CHATBAN_DURATION_MS,
    HORROR_EFFECTS,
    VOICEBAN_DURATION_MS,
    type HorrorEffect,
    type StreamerServerEvent,
} from './streamer-events';

/** The two things brobot can ask this machine to do. */
export type BanCommand = 'chatban' | 'voiceban';

export const BAN_COMMANDS: readonly BanCommand[] = ['chatban', 'voiceban'];

/** What each ban lasts when the server does not say (the chat copy's numbers). */
export const DEFAULT_BAN_DURATION_MS: Readonly<Record<BanCommand, number>> = {
    chatban: CHATBAN_DURATION_MS,
    voiceban: VOICEBAN_DURATION_MS,
};

/**
 * The longest ban this client will apply, whatever the server asks for.
 *
 * The server is trusted to send `chatban`, but a stuck keyboard is the one
 * failure a streamer cannot click their way out of mid-stream, so the client
 * does not take an arbitrary duration on faith. Fifteen minutes is three times
 * the longest ban the chat copy promises.
 */
export const MAX_BAN_DURATION_MS = 15 * 60 * 1000;

/** Nothing shorter than a second is a ban; it is a glitch. */
export const MIN_BAN_DURATION_MS = 1000;

export function clampBanDuration(durationMs: number): number {
    return Math.min(MAX_BAN_DURATION_MS, Math.max(MIN_BAN_DURATION_MS, Math.round(durationMs)));
}

/**
 * Parses one text frame from brobot; `null` for anything malformed or of an
 * unknown type. Unknown types are ignored, not errors: the contract lets
 * either side add a type first.
 *
 * A ban without a usable `durationMs` gets the default for its kind — the
 * 2022 server sent none, and "the ban the chat was promised" is a better
 * answer than refusing a ban the viewers voted for.
 */
export function parseStreamerServerEvent(frame: string): StreamerServerEvent | null {
    let value: unknown;
    try {
        value = JSON.parse(frame);
    } catch {
        return null;
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    switch (record['type']) {
        case 'chatban':
        case 'voiceban': {
            const type = record['type'];
            const duration = record['durationMs'];
            const durationMs =
                typeof duration === 'number' && Number.isFinite(duration) && duration > 0
                    ? duration
                    : DEFAULT_BAN_DURATION_MS[type];
            return { type, durationMs };
        }
        case 'horror': {
            // A horror redemption for the game on this machine: a known effect, and who redeemed it (for its ticker).
            const effect = record['effect'];
            const user = record['user'];
            if (typeof effect !== 'string' || !(HORROR_EFFECTS as readonly string[]).includes(effect)) return null;
            return { type: 'horror', effect: effect as HorrorEffect, user: typeof user === 'string' ? user.slice(0, 64) : '' };
        }
        case 'horror_chat': {
            // A chat line from the channel for the horror game (brobot's SLEEP TIGHT rehearsal / live modes).
            const user = record['user'];
            const text = record['text'];
            if (typeof text !== 'string' || text.length === 0) return null;
            return { type: 'horror_chat', user: typeof user === 'string' ? user.slice(0, 64) : '', text: text.slice(0, 300) };
        }
        case 'create_marker_complete':
        case 'create_prediction_complete':
        case 'play_ad_complete': {
            // brobot's answer to one of the streamer's hotkeys: no `error` means Twitch did it.
            const type = record['type'];
            const error = record['error'];
            return typeof error === 'string' && error.length > 0 ? { type, error: error.slice(0, 300) } : { type };
        }
        case 'overlay_status': {
            // How many stream overlays (browser sources) brobot sees; 0 means it refunds every roar.
            const connected = record['connected'];
            return typeof connected === 'number' && Number.isInteger(connected) && connected >= 0
                ? { type: 'overlay_status', connected }
                : null;
        }
        case 'ping': {
            const sentAt = record['sentAt'];
            return typeof sentAt === 'number' && Number.isFinite(sentAt) ? { type: 'ping', sentAt } : null;
        }
        default:
            return null;
    }
}

/** A human-readable duration for the log and the chat-facing copy: "5 min", "30 s". */
export function formatDuration(ms: number): string {
    const seconds = Math.round(ms / 1000);
    if (seconds < 60) return `${seconds} s`;
    const minutes = Math.floor(seconds / 60);
    const rest = seconds % 60;
    return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`;
}
