/**
 * The implementation of every host operation, typed against the shared
 * contract: a handler returning the wrong shape, or an operation with no
 * handler, does not compile.
 */

import {
    BAN_COMMANDS,
    type BanCommand,
    type OperationName,
    type OperationRequest,
    type OperationResponse,
    type SettingsPatch,
} from '@brobot-client/shared';
import type { ClientController } from '../core/controller';

export type Handlers = {
    [K in OperationName]: (request: OperationRequest<K>) => Promise<OperationResponse<K>>;
};

export function createHandlers(controller: ClientController): Handlers {
    return {
        'client.snapshot': async () => controller.snapshot(),
        'settings.update': async request => controller.updateSettings(validPatch(request)),
        'settings.setSecret': async request => controller.setSecret(validSecret(request)),
        'command.test': async request => controller.test(validCommand(field(request, 'command'))),
        'command.releaseAll': async () => controller.releaseAll(),
        'connection.reconnect': async () => controller.reconnect(),
        'log.clear': async () => controller.clearLog(),
    };
}

/**
 * The renderer is typed against the contract, but IPC is a trust boundary:
 * a compromised page could send anything. Only known fields of known types
 * get through.
 */
function validPatch(request: unknown): SettingsPatch {
    if (typeof request !== 'object' || request === null) throw new Error('Invalid settings.');
    const r = request as Record<string, unknown>;
    const patch: { -readonly [K in keyof SettingsPatch]: SettingsPatch[K] } = {};
    if (typeof r['serverUrl'] === 'string' && r['serverUrl'].length <= 2048) patch.serverUrl = r['serverUrl'];
    for (const key of ['safeMode', 'paused', 'startWithWindows'] as const) {
        if (typeof r[key] === 'boolean') patch[key] = r[key];
    }
    if (typeof r['commands'] === 'object' && r['commands'] !== null) {
        const commands: Partial<Record<BanCommand, boolean>> = {};
        for (const command of BAN_COMMANDS) {
            const value = (r['commands'] as Record<string, unknown>)[command];
            if (typeof value === 'boolean') commands[command] = value;
        }
        patch.commands = commands;
    }
    return patch;
}

/** A field of an untrusted request, whatever shape it arrived in. */
function field(request: unknown, key: string): unknown {
    return typeof request === 'object' && request !== null ? (request as Record<string, unknown>)[key] : undefined;
}

function validSecret(request: unknown): string {
    const secret = field(request, 'secret');
    if (typeof secret !== 'string' || secret.length > 4096) throw new Error('The secret must be text.');
    return secret;
}

function validCommand(value: unknown): BanCommand {
    if ((BAN_COMMANDS as readonly unknown[]).includes(value)) return value as BanCommand;
    throw new Error(`unknown command: ${String(value)}`);
}
