import { describe, expect, it } from 'vitest';
import { installerFor, isNewer, parseGitHubRelease, parseReleaseManifest } from './release';

const SHA = `${'A'.repeat(86)}==`;
const BASE = 'https://github.com/brother-bill/brobot-client/releases/download/v1.2.0/';

const GITHUB_JSON = {
    tag_name: 'v1.2.0',
    body: 'Fixes the mic mute.\r\n\r\nFaster Enter block.\r\n',
    assets: [
        { name: 'brobot-setup-1.2.0.exe', browser_download_url: `${BASE}brobot-setup-1.2.0.exe` },
        { name: 'brobot-update.json', browser_download_url: `${BASE}brobot-update.json` },
        { name: 'broken' },
        null,
    ],
};

const MANIFEST_JSON = {
    version: '1.2.0',
    installer: { file: 'brobot-setup-1.2.0.exe', size: 117_477_119, sha512: SHA },
};

describe('release', () => {
    it('finds the installer of a newer release, with the size and hash the build recorded', () => {
        const download = installerFor(parseGitHubRelease(GITHUB_JSON), parseReleaseManifest(MANIFEST_JSON), '1.1.0');
        expect(download).toEqual({
            version: '1.2.0',
            notes: 'Fixes the mic mute.\n\nFaster Enter block.',
            url: `${BASE}brobot-setup-1.2.0.exe`,
            file: 'brobot-setup-1.2.0.exe',
            size: 117_477_119,
            sha512: SHA,
        });
    });

    it('is null for the same or an older release', () => {
        const release = parseGitHubRelease(GITHUB_JSON);
        const manifest = parseReleaseManifest(MANIFEST_JSON);
        expect(installerFor(release, manifest, '1.2.0')).toBeNull();
        expect(installerFor(release, manifest, '1.10.0')).toBeNull();
    });

    it('refuses a release it cannot trust', () => {
        const manifest = parseReleaseManifest(MANIFEST_JSON);
        expect(() => installerFor(parseGitHubRelease({ ...GITHUB_JSON, tag_name: 'v1.3.0' }), manifest, '1.1.0')).toThrow(
            'tagged v1.3.0 but describes 1.2.0',
        );
        expect(() => installerFor(parseGitHubRelease({ ...GITHUB_JSON, assets: [] }), manifest, '1.1.0')).toThrow(
            'has no brobot-setup-1.2.0.exe',
        );
        const elsewhere = {
            ...GITHUB_JSON,
            assets: [{ name: 'brobot-setup-1.2.0.exe', browser_download_url: 'https://example.com/brobot-setup-1.2.0.exe' }],
        };
        expect(() => installerFor(parseGitHubRelease(elsewhere), manifest, '1.1.0')).toThrow('not hosted by brobot-client');
    });

    it('rejects a malformed manifest', () => {
        const withInstaller = (installer: object): unknown => ({ version: '1.2.0', installer });
        expect(() => parseReleaseManifest(null)).toThrow('not readable');
        expect(() => parseReleaseManifest({ ...MANIFEST_JSON, version: 'next' })).toThrow('not a version number');
        expect(() => parseReleaseManifest(withInstaller({ ...MANIFEST_JSON.installer, file: '../evil.exe' }))).toThrow(
            'not an installer file name',
        );
        expect(() => parseReleaseManifest(withInstaller({ ...MANIFEST_JSON.installer, size: 0 }))).toThrow('size');
        expect(() => parseReleaseManifest(withInstaller({ ...MANIFEST_JSON.installer, sha512: 'abc' }))).toThrow(
            'not a SHA-512',
        );
        expect(() => parseGitHubRelease({ body: 'x' })).toThrow('release tag is missing');
    });

    it('compares versions numerically', () => {
        expect(isNewer('1.10.0', '1.9.9')).toBe(true);
        expect(isNewer('2.0.0', '1.99.99')).toBe(true);
        expect(isNewer('v1.0.1', '1.0.0')).toBe(true);
        expect(isNewer('1.0.0', '1.0.0')).toBe(false);
        expect(isNewer('1.0.0-beta.1', '0.9.0')).toBe(false);
    });
});
