/**
 * Hands a horror redemption to the game running on this machine (SLEEP TIGHT, friend-slop-1's horror mode). The game
 * listens on 127.0.0.1:47811 for one JSON object per line: `{"event":"scream","user":"Ash","source":"redeem"}`.
 *
 * The socket lives in `services/game-relay-socket.ts` (Node's `net`); this file only defines the seam and the line, so
 * the controller and its spec stay free of Node imports.
 */

import type { HorrorEvent } from '@brobot-client/shared';

export const GAME_RELAY_HOST = '127.0.0.1';
export const GAME_RELAY_PORT = 47811;

export interface GameRelay {
    /** Sends one line; `onResult` says whether the game took it (false: the game is not running). */
    send(line: string, onResult: (delivered: boolean) => void): void;
}

/** The line the game reads for an event. */
export function relayLine(event: HorrorEvent): string {
    return JSON.stringify({ event: event.effect, user: event.user, source: 'redeem' }) + '\n';
}
