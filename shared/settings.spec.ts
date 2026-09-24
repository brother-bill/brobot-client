import { describe, expect, it } from 'vitest';
import { normalizeServerUrl, serverHost } from './settings';

function url(input: string): string {
    const result = normalizeServerUrl(input);
    if (!result.ok) throw new Error(result.error);
    return result.url;
}

describe('normalizeServerUrl', () => {
    it('accepts the full socket URL as is', () => {
        expect(url('wss://admin.brobot.live/api/ashketchum')).toBe('wss://admin.brobot.live/api/ashketchum');
    });

    it('fills in the scheme and the socket path when only a host is typed', () => {
        expect(url('admin.brobot.live')).toBe('wss://admin.brobot.live/api/ashketchum');
        expect(url('  https://admin.brobot.live/  ')).toBe('wss://admin.brobot.live/api/ashketchum');
    });

    it('keeps an explicit path and port', () => {
        expect(url('wss://example.test:8443/custom')).toBe('wss://example.test:8443/custom');
    });

    it('allows plain ws:// only to this computer', () => {
        expect(url('ws://localhost:3000')).toBe('ws://localhost:3000/api/ashketchum');
        expect(url('http://127.0.0.1:3000/api/ashketchum')).toBe('ws://127.0.0.1:3000/api/ashketchum');
        const remote = normalizeServerUrl('ws://admin.brobot.live');
        expect(remote.ok).toBe(false);
    });

    it('refuses what is not a socket address, and credentials in the URL', () => {
        expect(normalizeServerUrl('').ok).toBe(false);
        expect(normalizeServerUrl('ftp://admin.brobot.live').ok).toBe(false);
        expect(normalizeServerUrl('wss://user:secret@admin.brobot.live').ok).toBe(false);
        expect(normalizeServerUrl('wss://exa mple').ok).toBe(false);
    });
});

describe('serverHost', () => {
    it('is the host part, or the input when it is not a URL', () => {
        expect(serverHost('wss://admin.brobot.live/api/ashketchum')).toBe('admin.brobot.live');
        expect(serverHost('nonsense')).toBe('nonsense');
    });
});
