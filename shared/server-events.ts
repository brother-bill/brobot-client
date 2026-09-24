/**
 * The client's half of the `/api/ashketchum` contract: reading what brobot
 * sends. `streamer-events.ts` is the server's file, copied verbatim, and only
 * ships a parser for the other direction; this is its mirror image.
 */

import {
    CHATBAN_DURATION_MS,
    VOICEBAN_DURATION_MS,
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
