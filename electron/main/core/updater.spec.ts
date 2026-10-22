import { beforeEach, describe, expect, it } from 'vitest';
import {
    UPDATE_CHECK_INTERVAL_MS,
    UPDATE_FIRST_CHECK_DELAY_MS,
    type UpdateRelease,
    type UpdateStatus,
} from '@brobot-client/shared';
import { FakeClock, settle } from '../testing/fake-clock';
import { Updater, type UpdateBackend } from './updater';

const RELEASE: UpdateRelease = { version: '1.2.0', notes: 'Fixes the mic mute.' };

class FakeBackend implements UpdateBackend {
    checks = 0;
    downloads = 0;
    installs = 0;
    next: UpdateRelease | null | Error = null;
    downloadResult: Error | null = null;
    progress: number[] = [];

    check(): Promise<UpdateRelease | null> {
        this.checks++;
        return this.next instanceof Error ? Promise.reject(this.next) : Promise.resolve(this.next);
    }

    async download(onProgress: (percent: number) => void): Promise<void> {
        this.downloads++;
        for (const p of this.progress) onProgress(p);
        if (this.downloadResult !== null) throw this.downloadResult;
    }

    installResult: Error | null = null;

    async install(): Promise<void> {
        this.installs++;
        if (this.installResult !== null) throw this.installResult;
    }
}

describe('Updater', () => {
    let clock: FakeClock;
    let backend: FakeBackend;
    let emitted: UpdateStatus[];
    let announced: UpdateRelease[];
    let logs: { tone: string; message: string }[];
    let updater: Updater;

    function create(withBackend = true): Updater {
        return new Updater({
            clock,
            currentVersion: '1.1.0',
            backend: withBackend ? backend : null,
            unsupportedReason: 'The portable brobot cannot update itself.',
            emit: status => emitted.push(status),
            announce: release => announced.push(release),
            log: (tone, message) => logs.push({ tone, message }),
        });
    }

    beforeEach(() => {
        clock = new FakeClock();
        backend = new FakeBackend();
        emitted = [];
        announced = [];
        logs = [];
        updater = create();
    });

    it('without a backend it is unsupported, says why, and never schedules a check', async () => {
        updater = create(false);
        updater.start();
        expect(clock.pending).toBe(0);
        expect(updater.snapshot()).toMatchObject({
            phase: 'unsupported',
            currentVersion: '1.1.0',
            unsupportedReason: 'The portable brobot cannot update itself.',
        });
        await updater.check(true);
        await updater.install();
        expect(updater.snapshot().phase).toBe('unsupported');
    });

    it('looks a minute after start, then every four hours, quietly when up to date', async () => {
        updater.start();
        clock.advance(UPDATE_FIRST_CHECK_DELAY_MS - 1);
        expect(backend.checks).toBe(0);
        clock.advance(1);
        await settle();
        expect(backend.checks).toBe(1);
        expect(updater.snapshot()).toMatchObject({ phase: 'idle', lastCheckedAt: clock.now(), update: null });
        expect(logs).toEqual([]);

        clock.advance(UPDATE_CHECK_INTERVAL_MS);
        await settle();
        expect(backend.checks).toBe(2);
        expect(clock.pending).toBe(1);
    });

    it('offers a newer release and announces it once, however often it is seen again', async () => {
        backend.next = RELEASE;
        await updater.check();
        expect(updater.snapshot()).toMatchObject({ phase: 'available', update: RELEASE, dismissed: false });
        expect(announced).toEqual([RELEASE]);

        await updater.check();
        expect(announced).toEqual([RELEASE]);

        const newer = { version: '1.3.0', notes: '' };
        backend.next = newer;
        await updater.check();
        expect(announced).toEqual([RELEASE, newer]);
        expect(logs.map(l => l.message)).toEqual(['brobot 1.2.0 is available', 'brobot 1.3.0 is available']);
    });

    it('Later hides a release until a newer one appears or the streamer checks by hand', async () => {
        backend.next = RELEASE;
        await updater.check();
        expect(updater.dismiss().dismissed).toBe(true);

        await updater.check();
        expect(updater.snapshot()).toMatchObject({ phase: 'available', dismissed: true });

        await updater.check(true);
        expect(updater.snapshot().dismissed).toBe(false);

        updater.dismiss();
        backend.next = { version: '1.3.0', notes: '' };
        await updater.check();
        expect(updater.snapshot()).toMatchObject({ update: { version: '1.3.0' }, dismissed: false });
    });

    it('a failed check with nothing known is an error', async () => {
        backend.next = new Error('GitHub answered 503');
        await updater.check();
        expect(updater.snapshot()).toMatchObject({ phase: 'error', update: null });
    });

    it('a manual check says so when there is nothing newer', async () => {
        await updater.check(true);
        expect(logs).toEqual([{ tone: 'info', message: 'brobot 1.1.0 is the latest version' }]);
    });

    it('a failed check keeps the release it already knew, and only a manual one logs it', async () => {
        backend.next = RELEASE;
        await updater.check();
        backend.next = new Error('getaddrinfo ENOTFOUND github.com');
        await updater.check();
        expect(updater.snapshot()).toMatchObject({
            phase: 'available',
            update: RELEASE,
            lastError: 'Could not check for updates: getaddrinfo ENOTFOUND github.com',
        });
        expect(logs.filter(l => l.tone !== 'info')).toEqual([]);

        await updater.check(true);
        expect(logs.at(-1)).toEqual({
            tone: 'warning',
            message: 'Could not check for updates: getaddrinfo ENOTFOUND github.com',
        });
        // A failure still leaves the next timed check scheduled.
        expect(clock.pending).toBe(1);
    });

    it('Install downloads with progress, then hands over to the installer', async () => {
        backend.next = RELEASE;
        await updater.check();
        backend.progress = [12.4, 57.9, 140];
        await updater.install();
        expect(backend.downloads).toBe(1);
        expect(backend.installs).toBe(1);
        expect(emitted.filter(s => s.phase === 'downloading').map(s => s.percent)).toEqual([0, 12, 58, 100]);
        expect(updater.snapshot()).toMatchObject({ phase: 'installing', percent: 100 });
        // No check fires while the installer takes over.
        expect(clock.pending).toBe(0);
    });

    it('a failed download is an error the streamer can retry', async () => {
        backend.next = RELEASE;
        await updater.check();
        backend.downloadResult = new Error('net::ERR_CONNECTION_RESET');
        await updater.install();
        expect(backend.installs).toBe(0);
        expect(updater.snapshot()).toMatchObject({
            phase: 'error',
            update: RELEASE,
            lastError: 'The update did not download: net::ERR_CONNECTION_RESET',
        });
        expect(logs.at(-1)?.tone).toBe('error');

        backend.downloadResult = null;
        await updater.install();
        expect(backend.installs).toBe(1);
    });

    it('an installer that will not start leaves brobot running with an error', async () => {
        backend.next = RELEASE;
        await updater.check();
        backend.installResult = new Error('spawn UNKNOWN');
        await updater.install();
        expect(updater.snapshot()).toMatchObject({
            phase: 'error',
            update: RELEASE,
            lastError: 'The installer did not start: spawn UNKNOWN',
        });
        expect(clock.pending).toBe(1);
    });

    it('does nothing on Install before a release is known, or twice at once', async () => {
        await updater.install();
        expect(backend.downloads).toBe(0);

        backend.next = RELEASE;
        await updater.check();
        const first = updater.install();
        const second = updater.install();
        await Promise.all([first, second]);
        expect(backend.downloads).toBe(1);
    });
});
