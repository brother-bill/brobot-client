import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import {
    LibAlertBannerComponent,
    LibBtnDirective,
    LibCardComponent,
    LibCardContentComponent,
    LibCardHeaderComponent,
    LibCardTitleComponent,
    LibLiveDotComponent,
} from '@singularity/ngx-ui';
import { ClientStore } from '../core/client.store';
import { describeConnection, formatAgo } from '../core/describe';

/** The connection, in words, with the one button that helps when it is down. */
@Component({
    selector: 'app-status-panel',
    standalone: true,
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [
        LibAlertBannerComponent,
        LibBtnDirective,
        LibCardComponent,
        LibCardHeaderComponent,
        LibCardTitleComponent,
        LibCardContentComponent,
        LibLiveDotComponent,
    ],
    template: `
        <lib-card>
            <lib-card-header>
                <lib-card-title><h2 class="panel-title">Status</h2></lib-card-title>
            </lib-card-header>
            <lib-card-content class="stack">
                @if (view(); as v) {
                    <lib-live-dot [state]="v.dot" [label]="v.label" />
                    <p>{{ v.detail }}</p>
                    @if (heard(); as ago) {
                        <p class="muted">Last heard from brobot {{ ago }}.</p>
                    }
                    <div class="row">
                        <button
                            libBtn="secondary"
                            appearance="outlined"
                            type="button"
                            [disabled]="!configured()"
                            (click)="store.reconnect()">
                            Reconnect now
                        </button>
                    </div>
                }

                @if (store.settings()?.paused) {
                    <lib-alert-banner variant="warn">
                        <span class="row">
                            <span>Commands are paused. brobot is told no to every ban.</span>
                            <button libBtn="primary" appearance="filled" type="button" (click)="resume()">
                                Resume
                            </button>
                        </span>
                    </lib-alert-banner>
                }

                @if (store.host(); as host) {
                    @if (host.kind === 'dry-run') {
                        <lib-alert-banner variant="info">
                            Dry run: {{ host.reason }}. Commands are logged, but your keyboard and microphone are
                            not touched.
                        </lib-alert-banner>
                    }
                }
            </lib-card-content>
        </lib-card>
    `,
})
export class StatusPanelComponent {
    protected readonly store = inject(ClientStore);

    protected readonly configured = computed(() => this.store.settings()?.hasSecret ?? false);

    protected readonly view = computed(() => {
        const status = this.store.connection();
        const settings = this.store.settings();
        if (status === null || settings === null) return null;
        return describeConnection(status, settings.serverUrl, settings.hasSecret, this.store.now());
    });

    protected readonly heard = computed(() => {
        const status = this.store.connection();
        if (status?.state !== 'connected' || status.lastHeardAt === null) return null;
        return formatAgo(this.store.now() - status.lastHeardAt);
    });

    protected resume(): void {
        void this.store.updateSettings({ paused: false });
    }
}
