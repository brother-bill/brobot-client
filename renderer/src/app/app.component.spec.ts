import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { beforeEach, describe, expect, it } from 'vitest';
import {
    DEFAULT_KEY_BINDINGS,
    INITIAL_CONNECTION_STATUS,
    type BindingCheck,
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
        keyBindings: DEFAULT_KEY_BINDINGS,
        safeMode: false,
        paused: false,
        startWithWindows: true,
        setupComplete: true,
    },
    host: { kind: 'windows', reason: null },
    active: [],
    shortcuts: {
        create_marker: { state: 'active', combo: 'Ctrl+Alt+F5' },
        create_prediction: { state: 'taken', combo: 'Ctrl+Alt+F4' },
        play_ad: { state: 'active', combo: 'Ctrl+Alt+F7' },
    },
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
    check: BindingCheck = { errors: [], warnings: [] };
    readonly calls: { name: OperationName; request: unknown }[] = [];
    private readonly handlers = new Map<string, (payload: unknown) => void>();

    invoke(name: OperationName, request: unknown): Promise<never> {
        this.calls.push({ name, request });
        const response =
            name === 'client.snapshot' || name === 'settings.update'
                ? SNAPSHOT
                : name === 'keyBindings.check'
                  ? this.check
                  : name.startsWith('update.')
                    ? this.update
                    : undefined;
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

    describe('key bindings', () => {
        async function setup(): Promise<{ root: HTMLElement; settle: () => Promise<void> }> {
            const fixture = TestBed.createComponent(AppComponent);
            const settle = async (): Promise<void> => {
                for (let i = 0; i < 3; i++) {
                    await fixture.whenStable();
                    fixture.detectChanges();
                }
            };
            await settle();
            return { root: fixture.nativeElement as HTMLElement, settle };
        }

        const binding = (root: HTMLElement, label: string): HTMLElement =>
            [...root.querySelectorAll<HTMLElement>('.binding')].find(
                b => b.querySelector('.binding__label')?.textContent.trim() === label,
            )!;
        const button = (scope: HTMLElement, label: string): HTMLButtonElement =>
            [...scope.querySelectorAll('button')].find(b => b.textContent.trim() === label)!;
        const keydown = (target: Element, code: string, mods: KeyboardEventInit = {}): void => {
            target.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true, cancelable: true, ...mods }));
        };
        const calls = (name: OperationName) => bridge.calls.filter(c => c.name === name).map(c => c.request);

        it('lists every binding with its keys, flags a shortcut another app holds, and reminds about Streamlabs/OBS', async () => {
            const { root } = await setup();
            const text = (label: string) => binding(root, label).textContent.replace(/\s+/g, ' ');
            expect(text('Marker')).toContain('Ctrl+Alt+F5');
            expect(text('Marker')).toContain('Listening');
            expect(text('Prediction')).toContain('Warning: Not working: another app already uses Ctrl+Alt+F4');
            expect(text('Ad')).toContain('Ctrl+Alt+F7');
            expect(text('Voiceban start')).toContain('Streamlabs/OBS must have F8 bound to show the voiceban overlay.');
            expect(text('Voiceban end')).toContain('F9');
            // At their defaults: Off offered, Reset not.
            expect(button(binding(root, 'Marker'), 'Off')).toBeDefined();
            expect(button(binding(root, 'Marker'), 'Reset to Ctrl+Alt+F5')).toBeUndefined();
        });

        it('captures the next combination with the shortcuts let go, and saves it', async () => {
            const { root, settle } = await setup();
            button(binding(root, 'Marker'), 'Change').click();
            await settle();
            expect(calls('keyBindings.capture')).toEqual([{ active: true }]);
            const zone = binding(root, 'Marker').querySelector('.binding__capture')!;
            expect(document.activeElement).toBe(zone);

            keydown(zone, 'ControlLeft', { ctrlKey: true });
            keydown(zone, 'AltLeft', { ctrlKey: true, altKey: true });
            keydown(zone, 'F6', { ctrlKey: true, altKey: true });
            await settle();
            expect(calls('keyBindings.check')).toEqual([{ binding: 'create_marker', combo: 'Ctrl+Alt+F6' }]);
            expect(calls('settings.update')).toEqual([{ keyBindings: { create_marker: 'Ctrl+Alt+F6' } }]);
            expect(calls('keyBindings.capture')).toEqual([{ active: true }, { active: false }]);
            expect(binding(root, 'Marker').querySelector('.binding__capture')).toBeNull();
        });

        it('cancels on Esc, saving nothing', async () => {
            const { root, settle } = await setup();
            button(binding(root, 'Ad'), 'Change').click();
            await settle();
            keydown(binding(root, 'Ad').querySelector('.binding__capture')!, 'Escape');
            await settle();
            expect(calls('settings.update')).toEqual([]);
            expect(calls('keyBindings.capture')).toEqual([{ active: true }, { active: false }]);
        });

        it('says why a combination is refused and keeps listening for another', async () => {
            const { root, settle } = await setup();
            button(binding(root, 'Ad'), 'Change').click();
            await settle();
            const zone = (): Element => binding(root, 'Ad').querySelector('.binding__capture')!;
            keydown(zone(), 'Enter', { ctrlKey: true });
            await settle();
            expect(zone().textContent).toContain('Enter is the key a chat ban blocks');
            expect(calls('keyBindings.check')).toEqual([]);

            bridge.check = { errors: ['F8 is already the Voiceban start key. Each binding needs its own.'], warnings: [] };
            keydown(zone(), 'F8');
            await settle();
            expect(zone().textContent).toContain('F8 is already the Voiceban start key');
            expect(calls('settings.update')).toEqual([]);
        });

        it('asks before saving a shortcut on a common default, with the warning', async () => {
            bridge.check = { errors: [], warnings: ["Ctrl+Shift+M is Discord's Toggle Mute by default, so pressing it may set that off too."] };
            const { root, settle } = await setup();
            button(binding(root, 'Marker'), 'Change').click();
            await settle();
            keydown(binding(root, 'Marker').querySelector('.binding__capture')!, 'KeyM', { ctrlKey: true, shiftKey: true });
            await settle();
            expect(binding(root, 'Marker').textContent).toContain("Discord's Toggle Mute");
            expect(calls('settings.update')).toEqual([]);
            button(binding(root, 'Marker'), 'Save').click();
            await settle();
            expect(calls('settings.update')).toEqual([{ keyBindings: { create_marker: 'Ctrl+Shift+M' } }]);
        });

        it('shows the Streamlabs/OBS notice before a voiceban key changes, with Save and Cancel', async () => {
            const { root, settle } = await setup();
            const row = (): HTMLElement => binding(root, 'Voiceban start');
            button(row(), 'Change').click();
            await settle();
            keydown(row().querySelector('.binding__capture')!, 'F10');
            await settle();
            expect(row().textContent).toContain(
                'Streamlabs/OBS must have F10 bound to the overlay. Update the hotkey in Streamlabs → Settings → Hotkeys ' +
                    '(or OBS → Settings → Hotkeys) or the overlay will stop switching.',
            );
            button(row(), 'Cancel').click();
            await settle();
            expect(calls('settings.update')).toEqual([]);

            // Off goes through the same notice.
            button(row(), 'Off').click();
            await settle();
            expect(row().textContent).toContain('brobot will stop pressing a key as a voiceban starts');
            button(row(), 'Save').click();
            await settle();
            expect(calls('settings.update')).toEqual([{ keyBindings: { voiceban_start: 'none' } }]);
        });

        it('drops a check that answers after the change was cancelled', async () => {
            const { root, settle } = await setup();
            let answer: (check: BindingCheck) => void = () => undefined;
            const invoke = bridge.invoke.bind(bridge);
            bridge.invoke = ((name: OperationName, request: unknown) =>
                name === 'keyBindings.check'
                    ? (bridge.calls.push({ name, request }), new Promise<BindingCheck>(resolve => (answer = resolve)))
                    : invoke(name, request)) as never;
            button(binding(root, 'Ad'), 'Change').click();
            await settle();
            keydown(binding(root, 'Ad').querySelector('.binding__capture')!, 'F6', { ctrlKey: true });
            button(binding(root, 'Ad'), 'Cancel').click();
            await settle();
            answer({ errors: [], warnings: [] });
            // The late answer travels through a few promise hops; give it a turn.
            await new Promise(resolve => setTimeout(resolve, 50));
            await settle();
            expect(calls('keyBindings.check')).toHaveLength(1);
            expect(calls('settings.update')).toEqual([]);
        });

        it('tests each binding through the host', async () => {
            const { root } = await setup();
            button(binding(root, 'Ad'), 'Test').click();
            button(binding(root, 'Voiceban end'), 'Test').click();
            expect(calls('keyBindings.test')).toEqual([{ binding: 'play_ad' }, { binding: 'voiceban_end' }]);
        });
    });
});
