import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import {
    BAN_COMMANDS,
    DEFAULT_BAN_DURATION_MS,
    TEST_DURATION_MS,
    formatDuration,
    type BanCommand,
} from '@brobot-client/shared';
import {
    LibBtnDirective,
    LibCardComponent,
    LibCardContentComponent,
    LibCardHeaderComponent,
    LibCardTitleComponent,
    LibSlideToggleComponent,
} from '@singularity/ngx-ui';
import { ClientStore } from '../core/client.store';
import { COMMAND_COPY, formatCountdown } from '../core/describe';

/**
 * What brobot may do to this computer: pause everything, switch each command
 * on or off, try each one, and end whatever is running.
 */
@Component({
    selector: 'app-commands-panel',
    standalone: true,
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [
        LibBtnDirective,
        LibCardComponent,
        LibCardHeaderComponent,
        LibCardTitleComponent,
        LibCardContentComponent,
        LibSlideToggleComponent,
    ],
    styles: `
        .command {
            display: flex;
            flex-direction: column;
            gap: 0.5rem;
            padding-block: 0.75rem;
            border-top: 1px solid var(--ui-outline-variant);
        }
        .command__title {
            font: var(--ui-title-small);
            margin: 0;
        }
        .command__active {
            font-weight: 600;
            font-variant-numeric: tabular-nums;
        }
    `,
    template: `
        <lib-card>
            <lib-card-header>
                <lib-card-title><h2 class="panel-title">Commands</h2></lib-card-title>
            </lib-card-header>
            <lib-card-content class="stack">
                @if (store.settings(); as settings) {
                    <lib-slide-toggle [checked]="settings.paused" (change)="setPaused($event)">
                        Pause all commands
                    </lib-slide-toggle>

                    @for (row of rows(); track row.command) {
                        <section class="command" [attr.aria-labelledby]="'command-' + row.command">
                            <h3 class="command__title" [id]="'command-' + row.command">{{ row.title }}</h3>
                            <p class="muted">{{ row.effect }} Viewers vote with !{{ row.command }}; it lasts {{ row.duration }}.</p>
                            <lib-slide-toggle
                                [checked]="row.enabled"
                                (change)="setEnabled(row.command, $event)">
                                Obey !{{ row.command }}
                            </lib-slide-toggle>
                            @if (row.remaining !== null) {
                                <p class="command__active">
                                    {{ row.activeLabel }}{{ row.test ? ' (test)' : '' }}{{ row.dryRun ? ' (dry run)' : '' }}
                                    — {{ row.remaining }} left
                                </p>
                            }
                            <div class="row">
                                <button
                                    libBtn="secondary"
                                    appearance="outlined"
                                    type="button"
                                    [disabled]="row.remaining !== null"
                                    (click)="store.test(row.command)">
                                    Test {{ row.title.toLowerCase() }} ({{ testDuration }})
                                </button>
                            </div>
                        </section>
                    }

                    @if (store.active().length > 0) {
                        <div class="row">
                            <button libBtn="warn" appearance="filled" type="button" (click)="store.releaseAll()">
                                Release now
                            </button>
                            <span class="muted">Unblocks Enter and unmutes the microphone immediately.</span>
                        </div>
                    }
                }
            </lib-card-content>
        </lib-card>
    `,
})
export class CommandsPanelComponent {
    protected readonly store = inject(ClientStore);
    protected readonly testDuration = formatDuration(TEST_DURATION_MS);

    protected readonly rows = computed(() => {
        const settings = this.store.settings();
        const active = this.store.active();
        const now = this.store.now();
        return BAN_COMMANDS.map(command => {
            const running = active.find(b => b.command === command);
            return {
                command,
                ...COMMAND_COPY[command],
                activeLabel: COMMAND_COPY[command].active,
                duration: formatDuration(DEFAULT_BAN_DURATION_MS[command]),
                enabled: settings?.commands[command] ?? false,
                remaining: running === undefined ? null : formatCountdown(running.endsAt - now),
                test: running?.test ?? false,
                dryRun: running?.dryRun ?? false,
            };
        });
    });

    protected setPaused(paused: boolean): void {
        void this.store.updateSettings({ paused });
    }

    protected setEnabled(command: BanCommand, enabled: boolean): void {
        void this.store.updateSettings({ commands: { [command]: enabled } });
    }
}
