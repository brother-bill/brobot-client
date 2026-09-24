/**
 * What the tray icon shows, as a pure function of the app's state.
 *
 * The icon is the whole point of the tray — "is brobot running and listening"
 * at a glance — so the mapping is its own tested unit rather than a branch
 * inside the Electron wiring. Colour is never the only channel: each state has
 * its own shape (see `tray-icon.ts`) and its own tooltip words.
 */

import { serverHost, type ActiveBan, type ConnectionStatus } from '@brobot-client/shared';

/** The four icons. `paused` wins over the connection: it is the thing to notice. */
export type TrayGlyph = 'connected' | 'reconnecting' | 'disconnected' | 'paused';

export interface TrayState {
    readonly glyph: TrayGlyph;
    /** Hover text. Windows truncates tray tooltips at 127 characters. */
    readonly tooltip: string;
    /** The disabled first line of the tray menu. */
    readonly statusLine: string;
}

export interface TrayInput {
    readonly connection: ConnectionStatus;
    readonly paused: boolean;
    readonly safeMode: boolean;
    readonly setupComplete: boolean;
    readonly serverUrl: string;
    readonly active: readonly ActiveBan[];
}

export const TRAY_TOOLTIP_LIMIT = 127;

export function trayState(input: TrayInput): TrayState {
    const host = serverHost(input.serverUrl);
    let glyph: TrayGlyph;
    let statusLine: string;

    switch (input.connection.state) {
        case 'connected':
            glyph = 'connected';
            statusLine = `Connected to ${host}`;
            break;
        case 'connecting':
            glyph = 'reconnecting';
            statusLine = `Connecting to ${host}…`;
            break;
        case 'reconnecting':
            glyph = 'reconnecting';
            statusLine = `Reconnecting to ${host}…`;
            break;
        case 'disconnected':
            glyph = 'disconnected';
            statusLine = input.setupComplete ? 'Disconnected' : 'Not set up yet — open brobot to finish setup';
            break;
    }

    const notes: string[] = [];
    if (input.paused) {
        glyph = 'paused';
        notes.push('commands paused');
    }
    if (input.safeMode) notes.push('safe mode');
    const live = input.active.filter(b => !b.test);
    if (live.length > 0) notes.push(`${live.map(b => b.command).join(' + ')} in progress`);

    const tooltip = truncate(['brobot', statusLine, ...notes].join(' — '), TRAY_TOOLTIP_LIMIT);
    return { glyph, tooltip, statusLine };
}

function truncate(text: string, limit: number): string {
    return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}
