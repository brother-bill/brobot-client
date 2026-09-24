/**
 * The renderer's view of the host: the bridge the preload installs as
 * `window.brobot`, or — when the dev server is opened in a plain browser — a
 * stand-in that fails every call with a reason instead of hanging.
 */

import { InjectionToken, type Provider } from '@angular/core';
import type {
    BrobotBridge,
    HostEventName,
    HostEvents,
    OperationName,
    OperationRequest,
    OperationResponse,
} from '@brobot-client/shared';

export const HOST_BRIDGE = new InjectionToken<BrobotBridge>('brobot.HostBridge');

declare global {
    interface Window {
        brobot?: BrobotBridge;
    }
}

export class UnavailableBridge implements BrobotBridge {
    static readonly reason =
        'This window is running outside the brobot desktop app, so it cannot reach brobot or this computer. ' +
        'Start it with `pnpm --filter @singularity/brobot-client run dev`.';

    invoke<K extends OperationName>(name: K, _request: OperationRequest<K>): Promise<OperationResponse<K>> {
        return Promise.reject(new Error(`${UnavailableBridge.reason} (tried: ${name})`));
    }

    on<K extends HostEventName>(_name: K, _handler: (payload: HostEvents[K]) => void): () => void {
        return () => undefined;
    }
}

export function isDesktopShell(): boolean {
    return typeof window !== 'undefined' && window.brobot !== undefined;
}

export function provideHostBridge(): Provider {
    return {
        provide: HOST_BRIDGE,
        useFactory: (): BrobotBridge => window.brobot ?? new UnavailableBridge(),
    };
}

export function messageOf(error: unknown): string {
    if (error instanceof Error) {
        // Electron prefixes IPC rejections with "Error invoking remote method
        // '…': Error:", which is noise in a message the streamer reads.
        return error.message.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');
    }
    return String(error);
}
