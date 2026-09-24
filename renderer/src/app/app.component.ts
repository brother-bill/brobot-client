import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { LibAlertBannerComponent, LibLiveDotComponent } from '@singularity/ngx-ui';
import { ClientStore } from './core/client.store';
import { describeConnection } from './core/describe';
import { CommandsPanelComponent } from './panels/commands-panel.component';
import { EventLogComponent } from './panels/event-log.component';
import { SettingsPanelComponent } from './panels/settings-panel.component';
import { StatusPanelComponent } from './panels/status-panel.component';

/**
 * One small window: status, the two commands, the log, settings. Until setup
 * is done, settings come first — there is nothing else to do yet.
 */
@Component({
    selector: 'app-root',
    standalone: true,
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [
        LibAlertBannerComponent,
        LibLiveDotComponent,
        StatusPanelComponent,
        CommandsPanelComponent,
        EventLogComponent,
        SettingsPanelComponent,
    ],
    styleUrl: './app.component.scss',
    template: `
        <header class="app-header">
            <h1 class="app-header__title">brobot</h1>
            @if (connection(); as view) {
                <lib-live-dot [state]="view.dot" [label]="view.label" />
            }
        </header>

        <main class="app-body">
            @if (store.error(); as message) {
                <lib-alert-banner variant="error" [dismissible]="store.desktop" (dismissed)="store.dismissError()">
                    {{ message }}
                </lib-alert-banner>
            }

            @if (setupComplete()) {
                <app-status-panel />
                <app-commands-panel />
                <app-event-log />
                <app-settings-panel />
            } @else {
                <app-settings-panel [firstRun]="true" />
                <app-status-panel />
                <app-commands-panel />
                <app-event-log />
            }
        </main>

        <!-- What this computer just did, read out as it happens. The log itself
             is not a live region: connection chatter would drown this out. -->
        <p class="sr-only" aria-live="polite">{{ lastHostAction() }}</p>
    `,
})
export class AppComponent {
    protected readonly store = inject(ClientStore);

    protected readonly setupComplete = computed(() => this.store.settings()?.setupComplete ?? true);

    protected readonly connection = computed(() => {
        const status = this.store.connection();
        const settings = this.store.settings();
        if (status === null || settings === null) return null;
        // The header lamp does not tick with the clock; the status panel does.
        return describeConnection(status, settings.serverUrl, settings.hasSecret, 0);
    });

    protected readonly lastHostAction = computed(
        () => this.store.log().findLast(entry => entry.source === 'host')?.message ?? '',
    );
}
