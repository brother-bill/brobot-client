/**
 * The Electron/Node half of updating: ask GitHub for the latest release,
 * download its installer, check it against the build's SHA-512, and run it.
 *
 * Deliberately not electron-updater: it would be the app's first dependency
 * outside the shared lockfile's tree, and this is the whole of what it would
 * do here — one provider, one installer, no delta updates. `core/release.ts`
 * holds the parts with logic, and their specs.
 *
 * The installer is electron-builder's NSIS one. `/S` installs silently into
 * the folder the streamer chose the first time (it reads that from the
 * registry), `--updated` marks it as an update, and `--force-run` starts the
 * new brobot when it is done. It waits for this process to exit, which
 * `app.quit()` below sees to; quitting releases any ban first (`before-quit`).
 */

import { app, net } from 'electron';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { UpdateRelease } from '@brobot-client/shared';
import {
    RELEASE_MANIFEST_NAME,
    installerFor,
    parseGitHubRelease,
    parseReleaseManifest,
    type InstallerDownload,
} from '../core/release';
import type { UpdateBackend } from '../core/updater';

const LATEST_RELEASE_URL = 'https://api.github.com/repos/brother-bill/brobot-client/releases/latest';

/** GitHub refuses API calls without a User-Agent. */
const HEADERS = { 'User-Agent': 'brobot-client', Accept: 'application/vnd.github+json' };

export class GitHubUpdateBackend implements UpdateBackend {
    private found: InstallerDownload | null = null;
    private downloaded: string | null = null;

    constructor(private readonly currentVersion: string) {}

    async check(): Promise<UpdateRelease | null> {
        const response = await net.fetch(LATEST_RELEASE_URL, { headers: HEADERS });
        // No release published yet.
        if (response.status === 404) return this.forget();
        if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
        const release = parseGitHubRelease(await response.json());

        const manifestAsset = release.assets.find(a => a.name === RELEASE_MANIFEST_NAME);
        if (manifestAsset === undefined) throw new Error(`The latest release has no ${RELEASE_MANIFEST_NAME}.`);
        const manifestResponse = await net.fetch(manifestAsset.url, { headers: HEADERS });
        if (!manifestResponse.ok) throw new Error(`GitHub answered ${manifestResponse.status} for the release manifest`);
        const manifest = parseReleaseManifest(await manifestResponse.json());

        const download = installerFor(release, manifest, this.currentVersion);
        if (download === null) return this.forget();
        if (download.version !== this.found?.version) this.downloaded = null;
        this.found = download;
        return { version: download.version, notes: download.notes };
    }

    async download(onProgress: (percent: number) => void): Promise<void> {
        const found = this.found;
        if (found === null) throw new Error('There is no update to download.');
        const dir = join(app.getPath('temp'), 'brobot-update');
        const path = join(dir, found.file);
        await mkdir(dir, { recursive: true });

        const response = await net.fetch(found.url, { headers: { 'User-Agent': HEADERS['User-Agent'] } });
        if (!response.ok || response.body === null) throw new Error(`GitHub answered ${response.status}`);

        const hash = createHash('sha512');
        const file = createWriteStream(path);
        let received = 0;
        try {
            const reader = response.body.getReader();
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                hash.update(value);
                received += value.byteLength;
                if (!file.write(value)) await new Promise<void>(resolve => file.once('drain', () => resolve()));
                onProgress((received / found.size) * 100);
            }
            await new Promise<void>((resolve, reject) => file.end((error?: Error | null) => (error ? reject(error) : resolve())));
        } catch (error) {
            file.destroy();
            await rm(path, { force: true });
            throw error;
        }

        const size = (await stat(path)).size;
        if (size !== found.size || hash.digest('base64') !== found.sha512) {
            await rm(path, { force: true });
            throw new Error('the downloaded installer does not match the release, so it was deleted');
        }
        this.downloaded = path;
    }

    /** Resolves once the installer has started, and quits; rejects, and stays, if it cannot start. */
    async install(): Promise<void> {
        const path = this.downloaded;
        if (path === null) throw new Error('The update has not been downloaded.');
        await new Promise<void>((resolve, reject) => {
            const child = spawn(path, ['/S', '--updated', '--force-run'], { detached: true, stdio: 'ignore' });
            // An installer that cannot start (deleted by antivirus, say)
            // reports it here; unlistened, it would crash this process.
            child.once('error', reject);
            child.once('spawn', () => {
                child.unref();
                resolve();
            });
        });
        app.quit();
    }

    private forget(): null {
        this.found = null;
        this.downloaded = null;
        return null;
    }
}
