/**
 * The only script that sees both worlds, and it exposes exactly two functions
 * over two fixed channels — never `ipcRenderer` itself, which would hand the
 * page every IPC channel in the app, Electron's internal ones included.
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

const INVOKE_CHANNEL = 'brobot:invoke';
const EVENT_CHANNEL = 'brobot:event';

/** Mirrors `HOST_EVENT_NAMES`; literal because the preload is bundled on its own. */
const EVENT_NAMES = ['client.snapshot', 'log.appended'] as const;

const bridge = {
    invoke(name: string, request: unknown): Promise<unknown> {
        return ipcRenderer.invoke(INVOKE_CHANNEL, name, request);
    },

    on(name: string, handler: (payload: unknown) => void): () => void {
        if (!(EVENT_NAMES as readonly string[]).includes(name)) {
            throw new Error(`unknown host event: ${name}`);
        }
        const listener = (_event: IpcRendererEvent, incoming: string, payload: unknown): void => {
            if (incoming === name) handler(payload);
        };
        ipcRenderer.on(EVENT_CHANNEL, listener);
        return () => ipcRenderer.removeListener(EVENT_CHANNEL, listener);
    },
};

contextBridge.exposeInMainWorld('brobot', bridge);
