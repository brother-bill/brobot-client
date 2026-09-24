/**
 * Settings on disk: `%APPDATA%\brobot\settings.json`, with the secret as
 * `safeStorage` ciphertext (DPAPI on Windows — readable only by this Windows
 * user on this machine). The plaintext secret exists only in this process's
 * memory and in the socket's upgrade header; it never reaches the renderer.
 */

import { app, safeStorage } from 'electron';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { SettingsStore } from '../core/controller';
import { parseSettingsFile, toSettingsFile, type StoredSettings } from '../core/settings-file';

export class FileSettingsStore implements SettingsStore {
    private readonly path = join(app.getPath('userData'), 'settings.json');
    private settings: StoredSettings;
    private encryptedSecret: string | null;

    constructor() {
        const { settings, secret } = parseSettingsFile(this.readFile());
        this.settings = settings;
        this.encryptedSecret = secret;
    }

    /** `safeStorage` is only usable after `app` is ready; construct this after that. */
    get secureStorageAvailable(): boolean {
        return safeStorage.isEncryptionAvailable();
    }

    load(): StoredSettings {
        return this.settings;
    }

    save(settings: StoredSettings): void {
        this.settings = settings;
        this.write();
    }

    readSecret(): string | null {
        if (this.encryptedSecret === null || !this.secureStorageAvailable) return null;
        try {
            return safeStorage.decryptString(Buffer.from(this.encryptedSecret, 'base64'));
        } catch (error) {
            // A settings file copied from another machine or Windows account
            // cannot be decrypted here. Treat it as "no secret" — the window
            // asks for it again — rather than failing to start.
            console.warn('[settings] stored secret could not be decrypted:', error);
            return null;
        }
    }

    writeSecret(secret: string | null): void {
        if (secret === null) {
            this.encryptedSecret = null;
        } else {
            if (!this.secureStorageAvailable) {
                throw new Error('This computer has no secure storage available, so the secret cannot be saved.');
            }
            this.encryptedSecret = safeStorage.encryptString(secret).toString('base64');
        }
        this.write();
    }

    private readFile(): unknown {
        try {
            return JSON.parse(readFileSync(this.path, 'utf8')) as unknown;
        } catch {
            return null;
        }
    }

    /** Write-then-rename, so a crash mid-write never leaves half a file. */
    private write(): void {
        mkdirSync(dirname(this.path), { recursive: true });
        const temp = `${this.path}.tmp`;
        writeFileSync(temp, `${JSON.stringify(toSettingsFile(this.settings, this.encryptedSecret), null, 2)}\n`, {
            encoding: 'utf8',
            mode: 0o600,
        });
        renameSync(temp, this.path);
    }
}
