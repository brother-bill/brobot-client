/**
 * The system-tray icon: the visible proof that brobot is running, and the one
 * control that is always reachable (Pause, Quit) even with the window hidden.
 * What it shows is decided by `core/tray-state.ts`; this file only draws it.
 */

import { Menu, Tray, nativeImage, type NativeImage } from 'electron';
import type { ClientSnapshot } from '@brobot-client/shared';
import { trayIconPng } from './core/tray-icon';
import { trayState, type TrayGlyph } from './core/tray-state';

export interface TrayActions {
    open(): void;
    setPaused(paused: boolean): void;
    setStartWithWindows(enabled: boolean): void;
    quit(): void;
}

export class AppTray {
    private readonly tray: Tray;
    private readonly icons = new Map<TrayGlyph, NativeImage>();
    private menuKey = '';
    private glyph: TrayGlyph | null = null;

    constructor(private readonly actions: TrayActions) {
        this.tray = new Tray(this.icon('disconnected'));
        this.tray.setToolTip('brobot');
        // Windows opens the context menu on right-click by itself; a left
        // click (or a double click) opens the window.
        this.tray.on('click', () => actions.open());
        this.tray.on('double-click', () => actions.open());
    }

    update(snapshot: ClientSnapshot): void {
        const { settings } = snapshot;
        const state = trayState({
            connection: snapshot.connection,
            paused: settings.paused,
            safeMode: settings.safeMode,
            setupComplete: settings.setupComplete,
            serverUrl: settings.serverUrl,
            active: snapshot.active,
        });
        if (state.glyph !== this.glyph) {
            this.glyph = state.glyph;
            this.tray.setImage(this.icon(state.glyph));
        }
        this.tray.setToolTip(state.tooltip);

        // Rebuilt only when something on it changed: the snapshot also moves
        // on every server ping, and a menu rebuilt while open closes itself.
        const key = JSON.stringify([state.statusLine, settings.paused, settings.startWithWindows]);
        if (key === this.menuKey) return;
        this.menuKey = key;
        this.tray.setContextMenu(
            Menu.buildFromTemplate([
                { label: state.statusLine, enabled: false },
                { type: 'separator' },
                { label: 'Open brobot', click: () => this.actions.open() },
                {
                    label: 'Pause commands',
                    type: 'checkbox',
                    checked: settings.paused,
                    click: item => this.actions.setPaused(item.checked),
                },
                {
                    label: 'Start with Windows',
                    type: 'checkbox',
                    checked: settings.startWithWindows,
                    click: item => this.actions.setStartWithWindows(item.checked),
                },
                { type: 'separator' },
                { label: 'Quit brobot', click: () => this.actions.quit() },
            ]),
        );
    }

    destroy(): void {
        this.tray.destroy();
    }

    private icon(glyph: TrayGlyph): NativeImage {
        let image = this.icons.get(glyph);
        if (image === undefined) {
            image = nativeImage.createEmpty();
            // 16 px at 100% scaling, 32 px for 200%; Windows picks.
            for (const [scaleFactor, size] of [
                [1, 16],
                [2, 32],
            ] as const) {
                image.addRepresentation({
                    scaleFactor,
                    width: size,
                    height: size,
                    buffer: Buffer.from(trayIconPng(glyph, size)),
                });
            }
            this.icons.set(glyph, image);
        }
        return image;
    }
}
