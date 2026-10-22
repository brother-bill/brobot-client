import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { LibAlertBannerComponent, LibBtnDirective, LibProgressBarComponent } from '@singularity/ngx-ui';
import { ClientStore } from '../core/client.store';

/**
 * "A new brobot is out": what changed, Install now, Later. It sits at the top
 * of the window while there is something to say and is gone otherwise.
 * Nothing downloads until Install now is clicked.
 */
@Component({
    selector: 'app-update-banner',
    standalone: true,
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [LibAlertBannerComponent, LibBtnDirective, LibProgressBarComponent],
    styles: `
        .notes {
            white-space: pre-wrap;
            max-height: 10rem;
            overflow-y: auto;
            margin: 0;
            padding: 0.5rem 0.75rem;
            border-radius: 0.5rem;
            background: var(--ui-surface-container-high);
            font: var(--ui-body-medium);
        }
        h2 {
            font: var(--ui-title-small);
            margin: 0;
        }
    `,
    template: `
        @if (view(); as v) {
            <section aria-labelledby="update-title">
                @switch (v.phase) {
                    @case ('available') {
                        <lib-alert-banner variant="info">
                            <div class="stack">
                                <h2 id="update-title">brobot {{ v.version }} is available</h2>
                                <p class="muted">You have {{ v.current }}.</p>
                                @if (v.notes !== '') {
                                    <div class="notes" tabindex="0" aria-label="What changed">{{ v.notes }}</div>
                                }
                                <p class="muted">
                                    Install now closes brobot for a few seconds and opens the new one. Any ban in
                                    progress ends first.
                                </p>
                                <div class="row">
                                    <button libBtn="primary" appearance="filled" type="button" (click)="store.installUpdate()">
                                        Install now
                                    </button>
                                    <button libBtn="secondary" appearance="outlined" type="button" (click)="store.dismissUpdate()">
                                        Later
                                    </button>
                                </div>
                            </div>
                        </lib-alert-banner>
                    }
                    @case ('downloading') {
                        <lib-alert-banner variant="info">
                            <div class="stack">
                                <h2 id="update-title">Downloading brobot {{ v.version }}</h2>
                                <lib-progress-bar
                                    mode="determinate"
                                    [value]="v.percent"
                                    ariaLabel="Update download"
                                    [ariaValueText]="v.percent + ' percent'" />
                                <p class="muted">{{ v.percent }}%. brobot keeps working while this runs.</p>
                            </div>
                        </lib-alert-banner>
                    }
                    @case ('installing') {
                        <lib-alert-banner variant="success">
                            <h2 id="update-title">Installing brobot {{ v.version }}</h2>
                            <p>brobot closes now and opens again by itself in a few seconds.</p>
                        </lib-alert-banner>
                    }
                    @case ('error') {
                        <lib-alert-banner variant="warn">
                            <div class="stack">
                                <h2 id="update-title">brobot {{ v.version }} did not install</h2>
                                <p>{{ v.error }}</p>
                                <div class="row">
                                    <button libBtn="primary" appearance="filled" type="button" (click)="store.installUpdate()">
                                        Try again
                                    </button>
                                    <button libBtn="secondary" appearance="outlined" type="button" (click)="store.dismissUpdate()">
                                        Later
                                    </button>
                                </div>
                            </div>
                        </lib-alert-banner>
                    }
                }
            </section>
        }
    `,
})
export class UpdateBannerComponent {
    protected readonly store = inject(ClientStore);

    protected readonly view = computed(() => {
        const status = this.store.update();
        if (status === null || status.update === null || status.dismissed) return null;
        // A failed timed check with a known release still offers it; a failed
        // check with nothing known says nothing here (Settings shows it).
        // A timed re-check of a known release keeps showing it.
        const phase = status.phase === 'checking' ? 'available' : status.phase;
        if (!['available', 'downloading', 'installing', 'error'].includes(phase)) return null;
        return {
            phase,
            version: status.update.version,
            notes: status.update.notes,
            current: status.currentVersion,
            percent: status.percent,
            error: status.lastError ?? '',
        };
    });
}
