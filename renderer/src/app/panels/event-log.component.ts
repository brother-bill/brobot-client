import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import {
    LibBtnDirective,
    LibCardComponent,
    LibCardContentComponent,
    LibCardHeaderComponent,
    LibCardTitleComponent,
} from '@singularity/ngx-ui';
import { ClientStore } from '../core/client.store';
import { SOURCE_LABEL, TONE_LABEL } from '../core/describe';

/**
 * What the bot asked and what this computer did, newest first.
 *
 * Not a live region (the app shell announces host actions on their own); the
 * list is a focusable scroll region so it can be read with the keyboard.
 */
@Component({
    selector: 'app-event-log',
    standalone: true,
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [LibBtnDirective, LibCardComponent, LibCardHeaderComponent, LibCardTitleComponent, LibCardContentComponent],
    styles: `
        .log {
            list-style: none;
            margin: 0;
            padding: 0;
            max-height: 16rem;
            overflow-y: auto;
            border: 1px solid var(--ui-outline-variant);
            border-radius: var(--ui-radius-sm, 4px);
        }
        .log__entry {
            display: grid;
            grid-template-columns: auto 1fr;
            gap: 0.125rem 0.75rem;
            padding: 0.375rem 0.625rem;
            border-left: 3px solid transparent;
        }
        .log__entry + .log__entry {
            border-top: 1px solid var(--ui-outline-variant);
        }
        .log__entry[data-tone='success'] {
            border-left-color: var(--ui-primary);
        }
        .log__entry[data-tone='warning'] {
            border-left-color: var(--ui-tertiary);
        }
        .log__entry[data-tone='error'] {
            border-left-color: var(--ui-error);
        }
        .log__meta {
            color: var(--ui-on-surface-variant);
            font-variant-numeric: tabular-nums;
            white-space: nowrap;
        }
        .log__tone {
            font-weight: 600;
        }
    `,
    template: `
        <lib-card>
            <lib-card-header>
                <lib-card-title><h2 class="panel-title" id="event-log-title">Event log</h2></lib-card-title>
            </lib-card-header>
            <lib-card-content class="stack">
                @if (entries().length === 0) {
                    <p class="muted">Nothing yet. Bans from brobot and what this computer did about them appear here.</p>
                } @else {
                    <!-- Scrollable, so it must be reachable by keyboard (WCAG 2.1.1). -->
                    <ol class="log" tabindex="0" aria-labelledby="event-log-title">
                        @for (entry of entries(); track entry.id) {
                            <li class="log__entry" [attr.data-tone]="entry.tone">
                                <span class="log__meta">
                                    <time [attr.datetime]="entry.iso">{{ entry.time }}</time>
                                </span>
                                <span>
                                    <span class="log__meta">{{ entry.source }} · </span>
                                    @if (entry.toneLabel) {
                                        <span class="log__tone">{{ entry.toneLabel }} </span>
                                    }
                                    {{ entry.message }}
                                </span>
                            </li>
                        }
                    </ol>
                    <div class="row">
                        <button libBtn="neutral" appearance="text" type="button" (click)="store.clearLog()">
                            Clear log
                        </button>
                    </div>
                }
            </lib-card-content>
        </lib-card>
    `,
})
export class EventLogComponent {
    protected readonly store = inject(ClientStore);

    private readonly timeFormat = new Intl.DateTimeFormat(undefined, {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    });

    protected readonly entries = computed(() =>
        [...this.store.log()].reverse().map(entry => ({
            id: entry.id,
            tone: entry.tone,
            toneLabel: TONE_LABEL[entry.tone],
            source: SOURCE_LABEL[entry.source],
            message: entry.message,
            time: this.timeFormat.format(entry.at),
            iso: new Date(entry.at).toISOString(),
        })),
    );
}
