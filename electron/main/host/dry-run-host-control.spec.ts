import { describe, expect, it } from 'vitest';
import { FakeClock } from '../testing/fake-clock';
import { DryRunHostControl } from './dry-run-host-control';

describe('DryRunHostControl', () => {
    it('keeps time like the real driver and records what it was asked', async () => {
        const clock = new FakeClock();
        const host = new DryRunHostControl(clock);
        const action = host.blockEnter(5000);
        expect(await action.started).toEqual({ ok: true, detail: 'dry run' });
        clock.advance(5000);
        expect(await action.done).toEqual({ ok: true, detail: 'dry run' });
        expect(host.calls).toEqual([
            { kind: 'block-enter', durationMs: 5000, startedAt: clock.time - 5000, endedAt: clock.time, released: false },
        ]);
    });

    it('ends on release, once, and clears its timer', async () => {
        const clock = new FakeClock();
        const host = new DryRunHostControl(clock);
        const action = host.muteMicrophone(30_000);
        action.release();
        action.release();
        expect(await action.done).toEqual({ ok: true, detail: 'released early (dry run)' });
        expect(clock.pending).toBe(0);
        expect(host.calls[0]?.released).toBe(true);
    });

    it('can be told to fail the next action', async () => {
        const host = new DryRunHostControl(new FakeClock(), 'no microphone');
        expect(await host.muteMicrophone(1000).started).toEqual({ ok: false, error: 'no microphone' });
        expect(await host.muteMicrophone(1000).started).toEqual({ ok: true, detail: 'dry run' });
    });
});
