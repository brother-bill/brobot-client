import { Socket } from 'node:net';
import {
    GAME_RELAY_HOST,
    GAME_RELAY_PORT,
    NO_HORROR_RUN,
    parseGameLine,
    parseGamePreview,
    type GameRelay,
    type HorrorPreview,
    type HorrorRun,
} from '../core/game-relay';

/** How often the watcher tries to reach the game while it is not running. */
const WATCH_RETRY_MS = 5000;

/**
 * The game relay over a local TCP socket: one connection kept open while the game runs. Lines sent while it connects
 * wait for it; if it cannot connect (the game is not running), they are dropped and reported as not delivered. While
 * {@link watchRun} is on, it also reconnects every few seconds on its own and reads the game's run lines.
 */
export class GameRelaySocket implements GameRelay {
    private socket: Socket | null = null;
    private connected = false;
    private pending: { line: string; onResult: (delivered: boolean) => void }[] = [];
    private onRun: ((run: HorrorRun) => void) | null = null;
    private onPreview: ((preview: HorrorPreview) => void) | null = null;
    private run: HorrorRun = NO_HORROR_RUN;
    private buffer = '';
    private timer: NodeJS.Timeout | null = null;

    constructor(
        private readonly host = GAME_RELAY_HOST,
        private readonly port = GAME_RELAY_PORT,
    ) {}

    send(line: string, onResult: (delivered: boolean) => void): void {
        if (this.socket && this.connected) {
            this.socket.write(line, error => onResult(!error));
            return;
        }
        this.pending.push({ line, onResult });
        if (!this.socket) this.open();
    }

    sendIfConnected(line: string): boolean {
        if (!this.socket || !this.connected) return false;
        this.socket.write(line);
        return true;
    }

    watchRun(onRun: (run: HorrorRun) => void, onPreview?: (preview: HorrorPreview) => void): void {
        this.onRun = onRun;
        this.onPreview = onPreview ?? null;
        if (this.timer) return;
        this.timer = setInterval(() => {
            if (!this.socket) this.open();
        }, WATCH_RETRY_MS);
        this.timer.unref();
        if (!this.socket) this.open();
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        this.onRun = null;
        this.onPreview = null;
        this.socket?.destroy();
    }

    private report(run: HorrorRun): void {
        this.run = run;
        this.onRun?.(run);
    }

    private open(): void {
        const socket = new Socket();
        this.socket = socket;
        this.buffer = '';
        socket.setTimeout(3000);
        socket.setEncoding('utf8');
        socket.on('connect', () => {
            this.connected = true;
            socket.setTimeout(0);
            const waiting = this.pending;
            this.pending = [];
            for (const p of waiting) socket.write(p.line, error => p.onResult(!error));
        });
        socket.on('data', (chunk: string) => {
            this.buffer += chunk;
            let newline = this.buffer.indexOf('\n');
            while (newline >= 0) {
                const text = this.buffer.slice(0, newline).trim();
                this.buffer = this.buffer.slice(newline + 1);
                const run = parseGameLine(text);
                if (run) this.report(run);
                const preview = run ? null : parseGamePreview(text);
                if (preview) this.onPreview?.(preview);
                newline = this.buffer.indexOf('\n');
            }
            if (this.buffer.length > 64 * 1024) this.buffer = '';
        });
        const fail = (): void => {
            const waiting = this.pending;
            this.pending = [];
            for (const p of waiting) p.onResult(false);
            this.connected = false;
            this.socket = null;
            socket.destroy();
        };
        socket.on('timeout', fail);
        socket.on('error', fail);
        socket.on('close', () => {
            if (this.socket === socket) {
                this.socket = null;
                this.connected = false;
            }
            // the game went away (closed, crashed, left the horror mode): no run any more
            if (this.run.live) this.report(NO_HORROR_RUN);
        });
        socket.connect(this.port, this.host);
    }
}
