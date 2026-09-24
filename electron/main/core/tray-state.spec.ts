import { describe, expect, it } from 'vitest';
import { INITIAL_CONNECTION_STATUS, type ConnectionStatus } from '@brobot-client/shared';
import { TRAY_TOOLTIP_LIMIT, trayState, type TrayInput } from './tray-state';

const base: TrayInput = {
    connection: INITIAL_CONNECTION_STATUS,
    paused: false,
    safeMode: false,
    setupComplete: true,
    serverUrl: 'wss://admin.brobot.live/api/ashketchum',
    active: [],
};

const withState = (state: ConnectionStatus['state']): TrayInput => ({
    ...base,
    connection: { ...INITIAL_CONNECTION_STATUS, state },
});

describe('trayState', () => {
    it('maps each connection state to its icon and words', () => {
        expect(trayState(withState('connected'))).toEqual({
            glyph: 'connected',
            statusLine: 'Connected to admin.brobot.live',
            tooltip: 'brobot — Connected to admin.brobot.live',
        });
        expect(trayState(withState('connecting')).glyph).toBe('reconnecting');
        expect(trayState(withState('reconnecting'))).toMatchObject({
            glyph: 'reconnecting',
            statusLine: 'Reconnecting to admin.brobot.live…',
        });
        expect(trayState(withState('disconnected'))).toMatchObject({ glyph: 'disconnected', statusLine: 'Disconnected' });
    });

    it('points a fresh install at setup', () => {
        expect(trayState({ ...base, setupComplete: false }).statusLine).toBe(
            'Not set up yet — open brobot to finish setup',
        );
    });

    it('shows pause over everything, and says so', () => {
        const state = trayState({ ...withState('connected'), paused: true, safeMode: true });
        expect(state.glyph).toBe('paused');
        expect(state.tooltip).toBe('brobot — Connected to admin.brobot.live — commands paused — safe mode');
    });

    it('mentions a real ban in progress, not a test', () => {
        const ban = { startedAt: 0, endsAt: 1, dryRun: false };
        const state = trayState({
            ...withState('connected'),
            active: [
                { ...ban, command: 'chatban', test: false },
                { ...ban, command: 'voiceban', test: true },
            ],
        });
        expect(state.tooltip).toBe('brobot — Connected to admin.brobot.live — chatban in progress');
    });

    it('keeps the tooltip within what Windows will show', () => {
        const state = trayState({ ...withState('connected'), serverUrl: `wss://${'a'.repeat(200)}.example/` });
        expect(state.tooltip.length).toBe(TRAY_TOOLTIP_LIMIT);
        expect(state.tooltip.endsWith('…')).toBe(true);
    });
});
