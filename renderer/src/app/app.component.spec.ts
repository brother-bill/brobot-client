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

class FakeBridge implements BrobotBridge {
    readonly calls: { name: OperationName; request: unknown }[] = [];
    private readonly handlers = new Map<string, (payload: unknown) => void>();

    invoke(name: OperationName, request: unknown): Promise<never> {
        this.calls.push({ name, request });
        return Promise.resolve((name === 'client.snapshot' ? SNAPSHOT : undefined) as never);
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
                    : undefined) as never,
            );
        const root = await render();
        expect(root.querySelector('h2')?.textContent.trim()).toBe('Set up brobot');
    });
});
