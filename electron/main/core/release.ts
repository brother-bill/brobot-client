/**
 * Reading a brobot release off GitHub, without trusting it: the shape is
 * checked field by field, and the installer is only ever taken from this
 * repository's own release assets, with the size and SHA-512 the build wrote.
 *
 * A release is published by `scripts/publish-release.sh` and carries:
 *
 *     brobot-setup-<version>.exe     the installer the updater runs
 *     brobot-portable-<version>.exe  for streamers who download by hand
 *     brobot-update.json             { version, installer: { file, size, sha512 } }
 *
 * `brobot-update.json` is written by `scripts/release-manifest.mjs` at build
 * time, so the hash is of the file the build produced, not of whatever
 * GitHub serves later.
 */

export const RELEASE_MANIFEST_NAME = 'brobot-update.json';

/** The one origin an installer may be downloaded from. */
const ASSET_URL_PREFIX = 'https://github.com/brother-bill/brobot-client/releases/download/';

export interface ReleaseAsset {
    readonly name: string;
    readonly url: string;
}

/** What GitHub's "latest release" says, reduced to what the updater reads. */
export interface GitHubRelease {
    readonly tag: string;
    readonly notes: string;
    readonly assets: readonly ReleaseAsset[];
}

export interface ReleaseManifest {
    readonly version: string;
    readonly installer: { readonly file: string; readonly size: number; readonly sha512: string };
}

/** A newer release, ready to download. */
export interface InstallerDownload {
    readonly version: string;
    readonly notes: string;
    readonly url: string;
    readonly file: string;
    readonly size: number;
    /** Base64, as `scripts/release-manifest.mjs` writes it. */
    readonly sha512: string;
}

export function parseGitHubRelease(json: unknown): GitHubRelease {
    const r = record(json, 'The release');
    const tag = text(r['tag_name'], 'The release tag');
    const body = r['body'];
    const assets = Array.isArray(r['assets']) ? r['assets'] : [];
    return {
        tag,
        notes: typeof body === 'string' ? body.replace(/\r\n/g, '\n').trim() : '',
        assets: assets.flatMap(asset => {
            if (typeof asset !== 'object' || asset === null) return [];
            const a = asset as Record<string, unknown>;
            return typeof a['name'] === 'string' && typeof a['browser_download_url'] === 'string'
                ? [{ name: a['name'], url: a['browser_download_url'] }]
                : [];
        }),
    };
}

export function parseReleaseManifest(json: unknown): ReleaseManifest {
    const r = record(json, RELEASE_MANIFEST_NAME);
    const version = text(r['version'], 'The release version');
    if (parseVersion(version) === null) throw new Error(`"${version}" is not a version number.`);
    const installer = record(r['installer'], 'The installer entry');
    const file = text(installer['file'], 'The installer file name');
    if (!/^[\w.-]+\.exe$/.test(file)) throw new Error(`"${file}" is not an installer file name.`);
    const size = installer['size'];
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0) {
        throw new Error('The installer size is missing.');
    }
    const sha512 = text(installer['sha512'], 'The installer checksum');
    if (!/^[A-Za-z0-9+/]{86}==$/.test(sha512)) throw new Error('The installer checksum is not a SHA-512.');
    return { version, installer: { file, size, sha512 } };
}

/**
 * The download for `release`, when it is newer than `currentVersion`; null
 * when it is not. Throws when the release is newer but unusable (no manifest
 * entry for the installer, an installer hosted elsewhere, a tag that does not
 * match the manifest).
 */
export function installerFor(
    release: GitHubRelease,
    manifest: ReleaseManifest,
    currentVersion: string,
): InstallerDownload | null {
    if (release.tag.replace(/^v/, '') !== manifest.version) {
        throw new Error(`The release is tagged ${release.tag} but describes ${manifest.version}.`);
    }
    if (!isNewer(manifest.version, currentVersion)) return null;
    const asset = release.assets.find(a => a.name === manifest.installer.file);
    if (asset === undefined) throw new Error(`The release has no ${manifest.installer.file}.`);
    if (!asset.url.startsWith(ASSET_URL_PREFIX)) throw new Error('The installer is not hosted by brobot-client.');
    return {
        version: manifest.version,
        notes: release.notes,
        url: asset.url,
        file: manifest.installer.file,
        size: manifest.installer.size,
        sha512: manifest.installer.sha512,
    };
}

/** `a` is a later release than `b`. Plain `major.minor.patch`; anything else is never newer. */
export function isNewer(a: string, b: string): boolean {
    const x = parseVersion(a);
    const y = parseVersion(b);
    if (x === null || y === null) return false;
    for (let i = 0; i < 3; i++) {
        if (x[i] !== y[i]) return x[i]! > y[i]!;
    }
    return false;
}

function parseVersion(version: string): readonly [number, number, number] | null {
    const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version);
    return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])];
}

function record(value: unknown, what: string): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${what} is not readable.`);
    return value as Record<string, unknown>;
}

function text(value: unknown, what: string): string {
    if (typeof value !== 'string' || value === '') throw new Error(`${what} is missing.`);
    return value;
}
