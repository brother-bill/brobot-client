/**
 * The host contract — the single seam between the sandboxed window and the
 * machine underneath it (the same shape as apps/mediabot/shared/bridge.ts).
 *
 * The renderer never imports `electron`, never sees `ipcRenderer`, and never
 * touches the keyboard, the microphone or the socket. It calls
 * `bridge.invoke('command.test', …)`, and the main process does the rest.
 * Operations are declared as a map so one declaration drives the preload's
 * allow-list, the main-process router and the renderer's types.
 */

import type { ClientSnapshot, LogEntry } from './client-state';
import type { BanCommand } from './server-events';
import type { SettingsPatch } from './settings';

/**
 * Every operation the host exposes, as `name → { req, res }`.
 *
 * Adding one: an entry here, its name in `OPERATION_NAMES` (the guard below
 * fails to compile otherwise), a handler in `electron/main/ipc/handlers.ts`
 * (typed from this map), and a method on the renderer's `ClientStore`.
 */
export interface HostOperations {
    'client.snapshot': { req: void; res: ClientSnapshot };
    /** Rejects with a readable message when the server URL is invalid. */
    'settings.update': { req: SettingsPatch; res: ClientSnapshot };
    /** Stores the secret encrypted; an empty string forgets it. */
    'settings.setSecret': { req: { secret: string }; res: ClientSnapshot };
    /** Runs the host action once for `TEST_DURATION_MS`; nothing is sent to brobot. */
    'command.test': { req: { command: BanCommand }; res: void };
    /** Ends every ban in progress now: unblocks Enter, restores the mic. */
    'command.releaseAll': { req: void; res: void };
    /** Drops the current socket (if any) and connects again immediately. */
    'connection.reconnect': { req: void; res: void };
    'log.clear': { req: void; res: void };
}

export type OperationName = keyof HostOperations;
export type OperationRequest<K extends OperationName> = HostOperations[K]['req'];
export type OperationResponse<K extends OperationName> = HostOperations[K]['res'];

export const OPERATION_NAMES = [
    'client.snapshot',
    'settings.update',
    'settings.setSecret',
    'command.test',
    'command.releaseAll',
    'connection.reconnect',
    'log.clear',
] as const;

// Exhaustiveness guard: every key of HostOperations must appear above, and
// nothing else may.
type ListedName = (typeof OPERATION_NAMES)[number];
export type OperationListIsExhaustive = [
    Exclude<OperationName, ListedName>,
    Exclude<ListedName, OperationName>,
] extends [never, never]
    ? true
    : ['operation list out of sync', Exclude<OperationName, ListedName>, Exclude<ListedName, OperationName>];
const _operationListCheck: OperationListIsExhaustive = true;
void _operationListCheck;

/** Pushes from host to renderer. One payload type per event name. */
export interface HostEvents {
    /** Anything other than the log changed: connection, settings, bans, host. */
    'client.snapshot': ClientSnapshot;
    'log.appended': LogEntry;
}

export type HostEventName = keyof HostEvents;

export const HOST_EVENT_NAMES = ['client.snapshot', 'log.appended'] as const;

type ListedEvent = (typeof HOST_EVENT_NAMES)[number];
export type EventListIsExhaustive = [
    Exclude<HostEventName, ListedEvent>,
    Exclude<ListedEvent, HostEventName>,
] extends [never, never]
    ? true
    : ['event list out of sync'];
const _eventListCheck: EventListIsExhaustive = true;
void _eventListCheck;

/** What `window.brobot` provides; the renderer's `HOST_BRIDGE` wraps it. */
export interface BrobotBridge {
    invoke<K extends OperationName>(
        name: K,
        request: OperationRequest<K>,
    ): Promise<OperationResponse<K>>;
    on<K extends HostEventName>(name: K, handler: (payload: HostEvents[K]) => void): () => void;
}
