/**
 * Wiring the handlers to Electron IPC. The router is generated from
 * `OPERATION_NAMES`, so the channels the main process answers and the ones the
 * renderer may call are the same list by construction.
 */

import { ipcMain, type WebContents } from 'electron';
import { OPERATION_NAMES, type HostEventName, type HostEvents } from '@brobot-client/shared';
import type { Handlers } from './handlers';

/** Prefixed, so app IPC can never collide with Electron's own channels. */
export const IPC_INVOKE_CHANNEL = 'brobot:invoke';
export const IPC_EVENT_CHANNEL = 'brobot:event';

const subscribers = new Set<WebContents>();

export function registerIpc(handlers: Handlers): void {
    ipcMain.handle(IPC_INVOKE_CHANNEL, async (event, name: unknown, request: unknown) => {
        if (!subscribers.has(event.sender)) {
            // Only our own window may drive the host.
            throw new Error('IPC from an unknown sender');
        }
        if (typeof name !== 'string' || !(OPERATION_NAMES as readonly string[]).includes(name)) {
            throw new Error(`unknown host operation: ${String(name)}`);
        }
        const handler = handlers[name as keyof Handlers] as (req: unknown) => Promise<unknown>;
        return handler(request);
    });
}

/** Start pushing events to a window, and stop when it goes away. */
export function attachEvents(contents: WebContents): void {
    subscribers.add(contents);
    contents.once('destroyed', () => subscribers.delete(contents));
}

export function broadcast<K extends HostEventName>(name: K, payload: HostEvents[K]): void {
    for (const contents of subscribers) {
        if (!contents.isDestroyed()) {
            contents.send(IPC_EVENT_CHANNEL, name, payload);
        }
    }
}
