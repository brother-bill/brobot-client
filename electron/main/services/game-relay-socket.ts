import { Socket } from 'node:net';
import { GAME_RELAY_HOST, GAME_RELAY_PORT, type GameRelay } from '../core/game-relay';

/**
 * The game relay over a local TCP socket: one connection kept open while the game runs, opened again on the next event
 * after it drops. Lines sent while it connects wait for it; if it cannot connect (the game is not running), they are
 * dropped and reported as not delivered.
 */
export class GameRelaySocket implements GameRelay {
    private socket: Socket | null = null;
    private connected = false;
    private pending: { line: string; onResult: (delivered: boolean) => void }[] = [];

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

    private open(): void {
        const socket = new Socket();
        this.socket = socket;
        socket.setTimeout(3000);
        socket.on('connect', () => {
            this.connected = true;
            socket.setTimeout(0);
            const waiting = this.pending;
            this.pending = [];
            for (const p of waiting) socket.write(p.line, error => p.onResult(!error));
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
        });
        socket.connect(this.port, this.host);
    }
}
