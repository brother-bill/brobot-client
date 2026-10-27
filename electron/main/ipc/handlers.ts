/**
 * The implementation of every host operation, typed against the shared
 * contract: a handler returning the wrong shape, or an operation with no
 * handler, does not compile.
 */

import {
    BAN_COMMANDS,
    KEY_BINDING_IDS,
    isKeyBindingId,
    normalizeComboSetting,
    type BanCommand,
    type KeyBindingId,
    type KeyComboSetting,
    type OperationName,
    type OperationRequest,
    type OperationResponse,
    type SettingsPatch,
} from '@brobot-client/shared';
import type { ClientController } from '../core/controller';
import type { Updater } from '../core/updater';

export type Handlers = {
    [K in OperationName]: (request: OperationRequest<K>) => Promise<OperationResponse<K>>;
};

export function createHandlers(controller: ClientController, updater: Updater): Handlers {
    return {
        'client.snapshot': async () => controller.snapshot(),
        'settings.update': async request => controller.updateSettings(validPatch(request)),
        'settings.setSecret': async request => controller.setSecret(validSecret(request)),
        'command.test': async request => controller.test(validCommand(field(request, 'command'))),
        'keyBindings.check': async request =>
            controller.checkBinding(validBinding(field(request, 'binding')), validCombo(field(request, 'combo'))),
        'keyBindings.capture': async request => controller.captureKeys(field(request, 'active') === true),
        'keyBindings.test': async request => controller.testBinding(validBinding(field(request, 'binding'))),
        'command.releaseAll': async () => controller.releaseAll(),
        'connection.reconnect': async () => controller.reconnect(),
        'log.clear': async () => controller.clearLog(),
        'update.status': async () => updater.snapshot(),
        'update.check': async () => updater.check(true),
        'update.install': async () => updater.install(),
        'update.dismiss': async () => updater.dismiss(),
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
    if (typeof r['keyBindings'] === 'object' && r['keyBindings'] !== null) {
        const bindings: Partial<Record<KeyBindingId, KeyComboSetting>> = {};
        for (const id of KEY_BINDING_IDS) {
            const value = (r['keyBindings'] as Record<string, unknown>)[id];
            if (value !== undefined) bindings[id] = validCombo(value);
        }
        patch.keyBindings = bindings;
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

function validBinding(value: unknown): KeyBindingId {
    if (isKeyBindingId(value)) return value;
    throw new Error(`unknown key binding: ${String(value)}`);
}

function validCombo(value: unknown): KeyComboSetting {
    const combo = normalizeComboSetting(value);
    if (combo === null) throw new Error(`brobot does not know the key combination "${String(value).slice(0, 64)}".`);
    return combo;
}
