/**
 * Hands a horror redemption to the game running on this machine (SLEEP TIGHT, friend-slop-1's horror mode). The game
 * listens on 127.0.0.1:47811 for one JSON object per line: `{"event":"scream","user":"Ash","source":"redeem"}`.
 *
 * The game also talks back on the same connection: `{"type":"run","state":"start"|"end","dream":"Night Shift"}` when a
 * SLEEP TIGHT run starts or ends (and every 30 s during one). The client passes that on to brobot (`horror_run`), which
 * shows the horror channel-point rewards only while a run is being played.
 *
 * It also says `{"type":"preview","dream":"freddy","name":"Night Shift"}` when a dream's preview (ready-check) screen
 * appears; the client passes it on as `horror_preview` (brobot posts the dream's rules to chat in `live` mode only).
 * Chat lines brobot forwards (`horror_chat`, rehearsal / live) go to the game as `{"type":"chat","user":..,"text":..}`.
 *
 * The socket lives in `services/game-relay-socket.ts` (Node's `net`); this file only defines the seam and the lines, so
 * the controller and its spec stay free of Node imports.
 */

import type { HorrorChatEvent, HorrorEvent } from '@brobot-client/shared';

export const GAME_RELAY_HOST = '127.0.0.1';
export const GAME_RELAY_PORT = 47811;

/** What the game last said about its run. */
export interface HorrorRun {
    live: boolean;
    dream: string;
}

export const NO_HORROR_RUN: HorrorRun = { live: false, dream: '' };

/** The game showed a dream's preview screen. */
export interface HorrorPreview {
    dream: string;
    name: string;
}

export interface GameRelay {
    /** Sends one line; `onResult` says whether the game took it (false: the game is not running). */
    send(line: string, onResult: (delivered: boolean) => void): void;
    /**
     * Keeps a connection to the game (retrying while it is not running) and reports every run line it sends, plus
     * {@link NO_HORROR_RUN} when the game goes away during a run. Optional: a relay without it never shows the rewards.
     */
    watchRun?(onRun: (run: HorrorRun) => void, onPreview?: (preview: HorrorPreview) => void): void;
    /** Sends one line only if the game is connected right now (chat lines: never queued, never retried). */
    sendIfConnected?(line: string): boolean;
    /** Stops watching (on quit). */
    stop?(): void;
}

/** A line from the game: its run state, or null for anything else. */
export function parseGameLine(line: string): HorrorRun | null {
    let value: unknown;
    try {
        value = JSON.parse(line);
    } catch {
        return null;
    }
    if (typeof value !== 'object' || value === null) return null;
    const record = value as Record<string, unknown>;
    if (record.type !== 'run' || (record.state !== 'start' && record.state !== 'end')) return null;
    const live = record.state === 'start';
    return { live, dream: live && typeof record.dream === 'string' ? record.dream.slice(0, 64) : '' };
}

/** A line from the game: a dream preview, or null for anything else. */
export function parseGamePreview(line: string): HorrorPreview | null {
    let value: unknown;
    try {
        value = JSON.parse(line);
    } catch {
        return null;
    }
    if (typeof value !== 'object' || value === null) return null;
    const record = value as Record<string, unknown>;
    if (record.type !== 'preview' || typeof record.dream !== 'string' || record.dream.length === 0) return null;
    return { dream: record.dream.slice(0, 32), name: typeof record.name === 'string' ? record.name.slice(0, 64) : '' };
}

/** The line the game reads for a forwarded chat line. */
export function chatRelayLine(event: HorrorChatEvent): string {
    return JSON.stringify({ type: 'chat', user: event.user, text: event.text }) + '\n';
}

/** The line the game reads for an event. */
export function relayLine(event: HorrorEvent): string {
    return JSON.stringify({ event: event.effect, user: event.user, source: 'redeem' }) + '\n';
}
