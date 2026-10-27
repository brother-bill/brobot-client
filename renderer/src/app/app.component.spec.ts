import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { beforeEach, describe, expect, it } from 'vitest';
import {
    INITIAL_CONNECTION_STATUS,
    type BrobotBridge,
    type ClientSnapshot,
    type HostEventName,
    type HostEvents,
    type OperationName,
    type UpdateStatus,
} from '@brobot-client/shared';
import { provideLibUi } from '@singularity/ngx-ui';
import { AppComponent } from './app.component';
import { HOST_BRIDGE } from './core/host-bridge';

const SNAPSHOT: ClientSnapshot = {
    version: '1.0.0',
    connection: { ...INITIAL_CONNECTION_STATUS, state: 'connected', connectedAt: 1, lastHeardAt: Date.now() },
    settings: {
        serverUrl: 'wss://admin.brobot.live/api/ashketchum',
        hasSecret: true,
        commands: { chatban: true, voiceban: false },
        voicebanKeys: { start: 'F8', end: 'F9' },
        safeMode: false,
        paused: false,
        startWithWindows: true,
        setupComplete: true,
    },
    host: { kind: 'windows', reason: null },
    active: [],
    log: [{ id: 1, at: Date.now(), source: 'bot', tone: 'info', message: 'brobot asked for a chatban (5 min)' }],
    secureStorageAvailable: true,
};

const UP_TO_DATE: UpdateStatus = {
    phase: 'idle',
    currentVersion: '1.0.0',
    unsupportedReason: null,
    update: null,
    percent: 0,
    lastCheckedAt: null,
    lastError: null,
    dismissed: false,
};

const AVAILABLE: UpdateStatus = {
    ...UP_TO_DATE,
    phase: 'available',
    update: { version: '1.2.0', notes: 'Fixes the mic mute.' },
};

class FakeBridge implements BrobotBridge {
    update: UpdateStatus = UP_TO_DATE;
    readonly calls: { name: OperationName; request: unknown }[] = [];
    private readonly handlers = new Map<string, (payload: unknown) => void>();

    invoke(name: OperationName, request: unknown): Promise<never> {
        this.calls.push({ name, request });
        const response = name === 'client.snapshot' ? SNAPSHOT : name.startsWith('update.') ? this.update : undefined;
        return Promise.resolve(response as never);
    }

    on<K extends HostEventName>(name: K, handler: (payload: HostEvents[K]) => void): () => void {
        this.handlers.set(name, handler as (payload: unknown) => void);
        return () => this.handlers.delete(name);
    }

    push<K extends HostEventName>(name: K, payload: HostEvents[K]): void {
        this.handlers.get(name)?.(payload);
    }
}

describe('AppComponent', () => {
    let bridge: FakeBridge;

    beforeEach(() => {
        bridge = new FakeBridge();
        // The store only talks to the host inside the desktop shell.
        (window as { brobot?: BrobotBridge }).brobot = bridge;
        TestBed.configureTestingModule({
            imports: [AppComponent],
            providers: [provideZonelessChangeDetection(), provideLibUi(), { provide: HOST_BRIDGE, useValue: bridge }],
        });
    });

    async function render(): Promise<HTMLElement> {
        const fixture = TestBed.createComponent(AppComponent);
        await fixture.whenStable();
        fixture.detectChanges();
        await fixture.whenStable();
        return fixture.nativeElement as HTMLElement;
    }

    it('shows the connection, the commands and the log once the host answers', async () => {
        const root = await render();
        expect(bridge.calls[0]?.name).toBe('client.snapshot');
        expect(root.querySelector('h1')?.textContent).toBe('brobot');
        expect(root.querySelector('.app-header__version')?.textContent).toBe('v1.0.0');
        expect(root.textContent).toContain('Listening to brobot at admin.brobot.live.');
        expect(root.textContent).toContain('brobot asked for a chatban (5 min)');

        const switches = [...root.querySelectorAll<HTMLInputElement>('input[role="switch"]')];
        const obey = switches.filter(s => s.closest('label')?.textContent.includes('Obey'));
        expect(obey.map(s => s.checked)).toEqual([true, false]);
    });

    it('drives the host only through named operations', async () => {
        const root = await render();
        const test = [...root.querySelectorAll('button')].find(b => b.textContent.includes('Test chat ban'));
        expect(test).toBeDefined();
        test!.click();
        expect(bridge.calls.at(-1)).toEqual({ name: 'command.test', request: { command: 'chatban' } });
    });

    it('labels every form control', async () => {
        const root = await render();
        for (const input of root.querySelectorAll('input')) {
            const labelled =
                (input.labels?.length ?? 0) > 0 ||
                input.hasAttribute('aria-label') ||
                input.closest('label') !== null ||
                root.querySelector(`label[for="${input.id}"]`) !== null;
            expect(labelled, `input ${input.outerHTML} has no label`).toBeTruthy();
        }
    });

    it('leads with setup on a fresh install', async () => {
        bridge.invoke = (name: OperationName) =>
            Promise.resolve(
                (name === 'client.snapshot'
                    ? { ...SNAPSHOT, settings: { ...SNAPSHOT.settings, hasSecret: false, setupComplete: false } }
                    : name === 'update.status'
                      ? UP_TO_DATE
                      : undefined) as never,
            );
        const root = await render();
        expect(root.querySelector('h2')?.textContent.trim()).toBe('Set up brobot');
    });

    it('offers a newer brobot with its notes, and installs only when asked', async () => {
        bridge.update = AVAILABLE;
        const root = await render();
        expect(root.textContent).toContain('brobot 1.2.0 is available');
        expect(root.textContent).toContain('Fixes the mic mute.');
        expect(bridge.calls.some(c => c.name === 'update.install')).toBe(false);

        const button = (label: string): HTMLButtonElement =>
            [...root.querySelectorAll('button')].find(b => b.textContent.trim() === label)!;
        button('Install now').click();
        expect(bridge.calls.at(-1)?.name).toBe('update.install');
        button('Later').click();
        expect(bridge.calls.at(-1)?.name).toBe('update.dismiss');
    });

    it('shows no banner when up to date or after Later, and Settings can check by hand', async () => {
        bridge.update = { ...AVAILABLE, dismissed: true };
        const root = await render();
        expect(root.querySelector('app-update-banner')?.textContent.trim()).toBe('');
        expect(root.textContent.replace(/\s+/g, ' ')).toContain('Version 1.0.0. brobot 1.2.0 is available.');
        [...root.querySelectorAll('button')].find(b => b.textContent.includes('Check for updates'))!.click();
        expect(bridge.calls.at(-1)?.name).toBe('update.check');
    });

    it('follows the download as the host pushes it', async () => {
        bridge.update = AVAILABLE;
        const fixture = TestBed.createComponent(AppComponent);
        await fixture.whenStable();
        bridge.push('update.status', { ...AVAILABLE, phase: 'downloading', percent: 42 });
        fixture.detectChanges();
        await fixture.whenStable();
        const root = fixture.nativeElement as HTMLElement;
        expect(root.textContent).toContain('Downloading brobot 1.2.0');
        expect(root.textContent).toContain('42%');
    });
});
