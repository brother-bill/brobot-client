/**
 * Electron main process — the privileged half of brobot's streamer app.
 *
 * This process owns the machine: the socket to brobot, the keyboard hook and
 * the microphone (through PowerShell), the settings file and the tray. The
 * window owns none of that and is locked down accordingly (context isolation,
 * no node integration, sandboxed, navigation blocked) — the same posture as
 * apps/mediabot.
 *
 * It is a tray app: closing the window hides it, and only Quit (tray menu)
 * exits. One instance at a time — a second launch shows the first one's window.
 */

import { BrowserWindow, Menu, app, shell } from 'electron';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { systemClock } from './core/clock';
import { ClientController, type LoginItems } from './core/controller';
import { WindowsHostControl } from './host/windows-host-control';
import { createHandlers } from './ipc/handlers';
import { attachEvents, broadcast, registerIpc } from './ipc/register';
import { FileSettingsStore } from './services/settings-store';
import { wsSocketFactory } from './services/ws-socket';
import { AppTray } from './tray';

/** Set by the dev watcher; absent in a packaged build. */
const devServer = process.env['BROBOT_CLIENT_DEV_SERVER'] ?? null;

/** Passed by the Windows sign-in entry: start in the tray, no window. */
const HIDDEN_FLAG = '--hidden';

/** Must match `appId` in electron-builder.json, or Windows groups notifications and pins oddly. */
const APP_USER_MODEL_ID = 'live.brobot.client';

let mainWindow: BrowserWindow | null = null;
let tray: AppTray | null = null;
let controller: ClientController | null = null;
let quitting = false;

function createWindow(): BrowserWindow {
    const window = new BrowserWindow({
        width: 480,
        height: 760,
        minWidth: 380,
        minHeight: 480,
        show: false,
        title: 'brobot',
        backgroundColor: '#141218',
        autoHideMenuBar: true,
        webPreferences: {
            preload: join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            nodeIntegrationInWorker: false,
            nodeIntegrationInSubFrames: false,
            sandbox: true,
            webSecurity: true,
        },
    });

    window.once('ready-to-show', () => {
        window.show();
        if (devServer !== null) window.webContents.openDevTools({ mode: 'detach' });
    });

    // Nothing here navigates or opens windows. Real links go to the browser.
    window.webContents.setWindowOpenHandler(({ url }) => {
        if (url.startsWith('https://')) void shell.openExternal(url);
        return { action: 'deny' };
    });
    window.webContents.on('will-navigate', (event, url) => {
        if (!(devServer !== null && url.startsWith(devServer))) event.preventDefault();
    });

    // Close hides to the tray. Quit (tray menu) is the only way out, because a
    // streamer closing the window mid-stream must not silently stop the bot.
    window.on('close', event => {
        if (!quitting) {
            event.preventDefault();
            window.hide();
        }
    });
    window.on('closed', () => {
        mainWindow = null;
    });

    attachEvents(window.webContents);

    if (devServer !== null) {
        void window.loadURL(devServer);
    } else {
        void window.loadFile(join(__dirname, '../renderer/index.html'));
    }
    return window;
}

function showWindow(): void {
    if (mainWindow === null) {
        mainWindow = createWindow();
        return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
}

/**
 * Windows sign-in entry. The portable build runs from a temp directory that
 * changes on every launch; `PORTABLE_EXECUTABLE_FILE` is the .exe the user
 * actually has, and the one to register.
 */
const loginItems: LoginItems = {
    supported: app.isPackaged && process.platform === 'win32',
    set(enabled) {
        app.setLoginItemSettings({
            openAtLogin: enabled,
            path: process.env['PORTABLE_EXECUTABLE_FILE'] ?? process.execPath,
            args: [HIDDEN_FLAG],
        });
    },
};

/** An environment variable set to the empty string counts as unset. */
function nonEmpty(value: string | undefined): string | undefined {
    return value === undefined || value === '' ? undefined : value;
}

async function bootstrap(): Promise<void> {
    await app.whenReady();
    if (app.isPackaged) Menu.setApplicationMenu(null);

    const windowsHost =
        process.platform === 'win32'
            ? new WindowsHostControl({
                  clock: systemClock,
                  parentPid: process.pid,
                  spawn: (command, args) => {
                      const child = spawn(command, [...args], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
                      // `release()` may write "stop" to a shim that has just
                      // exited. EPIPE on a stream nobody listens to is an
                      // uncaught exception, which would take the app down.
                      child.stdin.on('error', () => undefined);
                      return child;
                  },
              })
            : null;

    const client = new ClientController({
        clock: systemClock,
        store: new FileSettingsStore(),
        socketFactory: wsSocketFactory,
        windowsHost,
        platform: process.platform,
        loginItems,
        version: app.getVersion(),
        emitSnapshot: snapshot => broadcast('client.snapshot', snapshot),
        emitLog: entry => broadcast('log.appended', entry),
        // Development only: point a dev run at a local brobot without saving
        // anything. Ignored in the installed app.
        override: app.isPackaged
            ? undefined
            : {
                  serverUrl: nonEmpty(process.env['BROBOT_SERVER_URL']),
                  secret: nonEmpty(process.env['BROBOT_WS_SECRET']),
              },
    });
    controller = client;
    registerIpc(createHandlers(client));

    tray = new AppTray({
        open: showWindow,
        setPaused: paused => client.updateSettings({ paused }),
        setStartWithWindows: enabled => client.updateSettings({ startWithWindows: enabled }),
        quit: () => app.quit(),
    });
    const appTray = tray;
    client.onChange(snapshot => appTray.update(snapshot));
    appTray.update(client.snapshot());

    // At sign-in the app starts quietly in the tray. Anything else — the
    // installer's "run after finish", a double-click — opens the window, and
    // so does a first run that still needs setting up.
    const hidden = process.argv.includes(HIDDEN_FLAG) && client.snapshot().settings.setupComplete;
    if (!hidden) showWindow();

    client.start();
}

if (!app.requestSingleInstanceLock()) {
    // Another brobot is already running; it will show its window (below).
    app.quit();
} else {
    app.setAppUserModelId(APP_USER_MODEL_ID);
    app.on('second-instance', () => {
        if (app.isReady()) showWindow();
    });
    // A tray app outlives its window.
    app.on('window-all-closed', () => undefined);
    app.on('before-quit', () => {
        quitting = true;
        // Unblock Enter and restore the mic before going: the shims would do
        // it themselves once this process is gone, but not a second later.
        controller?.shutdown();
        tray?.destroy();
    });
    void bootstrap();
}
