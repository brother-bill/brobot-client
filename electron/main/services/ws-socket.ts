/**
 * The real {@link SocketFactory}: a `ws` client carrying the secret in the
 * upgrade as `Authorization: Bearer <secret>`, which brobot's gateway checks
 * before a socket exists (the 2022 client's `token:` header still works there,
 * but is not what a new client should send).
 */

import WebSocket from 'ws';
import type { SocketFactory } from '../core/connection';

export const wsSocketFactory: SocketFactory = (url, secret, handlers) => {
    const socket = new WebSocket(url, {
        headers: { Authorization: `Bearer ${secret}` },
        // The connection manager has its own connect timeout; this is ws's
        // own backstop for a TCP connection that opens and then says nothing.
        handshakeTimeout: 15_000,
        // No redirects: a redirect would carry the secret somewhere else.
        followRedirects: false,
    });
    socket.on('open', () => handlers.onOpen());
    socket.on('message', (data, isBinary) => {
        if (isBinary) return;
        handlers.onMessage(rawText(data));
    });
    socket.on('ping', () => handlers.onProtocolPing());
    socket.on('error', error => handlers.onError(error));
    socket.on('close', (code, reason) => handlers.onClose(code, reason.toString('utf8')));
    return {
        send: text => socket.send(text),
        terminate: () => socket.terminate(),
    };
};

function rawText(data: WebSocket.RawData): string {
    if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
    if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
    return data.toString('utf8');
}
