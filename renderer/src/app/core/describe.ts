/**
 * The words the window uses for the app's state. Pure functions, so the
 * phrasing is tested once rather than re-derived in each template.
 */

import {
    formatDuration,
    serverHost,
    type BanCommand,
    type ConnectionStatus,
    type LogSource,
    type LogTone,
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
