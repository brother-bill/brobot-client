/**
 * Hands a horror redemption to the game running on this machine (SLEEP TIGHT, friend-slop-1's horror mode). The game
 * listens on 127.0.0.1:47811 for one JSON object per line: `{"event":"scream","user":"Ash","source":"redeem"}`.
 *
 * The game also talks back on the same connection: `{"type":"run","state":"start"|"end","dream":"Night Shift"}` when a
 * SLEEP TIGHT run starts or ends (and every 30 s during one). The client passes that on to brobot (`horror_run`), which
 * shows the horror channel-point rewards only while a run is being played.
 *
 * The socket lives in `services/game-relay-socket.ts` (Node's `net`); this file only defines the seam and the lines, so
 * the controller and its spec stay free of Node imports.
 */

import type { HorrorEvent } from '@brobot-client/shared';

export const GAME_RELAY_HOST = '127.0.0.1';
export const GAME_RELAY_PORT = 47811;

/** What the game last said about its run. */
export interface HorrorRun {
    live: boolean;
    dream: string;
}

export const NO_HORROR_RUN: HorrorRun = { live: false, dream: '' };

export interface GameRelay {
    /** Sends one line; `onResult` says whether the game took it (false: the game is not running). */
    send(line: string, onResult: (delivered: boolean) => void): void;
    /**
     * Keeps a connection to the game (retrying while it is not running) and reports every run line it sends, plus
     * {@link NO_HORROR_RUN} when the game goes away during a run. Optional: a relay without it never shows the rewards.
     */
    watchRun?(onRun: (run: HorrorRun) => void): void;
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

/** The line the game reads for an event. */
export function relayLine(event: HorrorEvent): string {
    return JSON.stringify({ event: event.effect, user: event.user, source: 'redeem' }) + '\n';
}
