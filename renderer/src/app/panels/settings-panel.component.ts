import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { FormControl, ReactiveFormsModule, type AbstractControl, type ValidationErrors } from '@angular/forms';
import { RELEASES_URL, normalizeServerUrl } from '@brobot-client/shared';
import {
    LibBtnDirective,
    LibCardComponent,
    LibCardContentComponent,
    LibCardHeaderComponent,
    LibCardTitleComponent,
    LibErrorComponent,
    LibFormFieldComponent,
    LibHintComponent,
    LibInputDirective,
    LibLabelComponent,
    LibSlideToggleComponent,
} from '@singularity/ngx-ui';
import { ClientStore } from '../core/client.store';
import { formatAgo } from '../core/describe';

/** The same rule the main process applies, so the window can say why before saving. */
function serverUrlValidator(control: AbstractControl<string>): ValidationErrors | null {
    const result = normalizeServerUrl(control.value);
    return result.ok ? null : { serverUrl: result.error };
}

/**
 * Where brobot is, the secret, and how this app behaves. On first run this is
 * the top panel and walks through the two things needed to connect.
 */
@Component({
    selector: 'app-settings-panel',
    standalone: true,
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [
        ReactiveFormsModule,
        LibBtnDirective,
        LibCardComponent,
        LibCardHeaderComponent,
        LibCardTitleComponent,
        LibCardContentComponent,
        LibFormFieldComponent,
        LibInputDirective,
        LibLabelComponent,
        LibHintComponent,
        LibErrorComponent,
        LibSlideToggleComponent,
    ],
    styles: `
        form {
            display: flex;
            flex-direction: column;
            gap: 0.5rem;
        }
        lib-form-field {
            width: 100%;
        }
    `,
    template: `
        <lib-card>
            <lib-card-header>
                <lib-card-title>
                    <h2 class="panel-title">{{ firstRun() ? 'Set up brobot' : 'Settings' }}</h2>
                </lib-card-title>
            </lib-card-header>
            <lib-card-content class="stack">
                @if (firstRun()) {
                    <p>
                        This app lets brobot run !chatban and !voiceban on this computer. Enter the server address
                        and the secret the brobot admin gave you. Nothing happens to your keyboard or microphone
                        until you save both.
                    </p>
                }

                @if (store.settings(); as settings) {
                    <form (submit)="saveServer($event)">
                        <lib-form-field>
                            <lib-label>Server address</lib-label>
                            <input
                                libInput
                                type="url"
                                autocomplete="off"
                                spellcheck="false"
                                [formControl]="serverUrl" />
                            <lib-hint>Usually wss://admin.brobot.live/api/ashketchum</lib-hint>
                            <lib-error>{{ serverUrlError() }}</lib-error>
                        </lib-form-field>
                        <div class="row">
                            <button libBtn="primary" appearance="filled" type="submit" [disabled]="!serverDirty()">
                                Save address
                            </button>
                        </div>
                    </form>

                    <form (submit)="saveSecret($event)">
                        <lib-form-field>
                            <lib-label>Secret</lib-label>
                            <input libInput type="password" autocomplete="off" [formControl]="secret" />
                            <lib-hint>{{
                                settings.hasSecret
                                    ? 'A secret is saved. Enter a new one to replace it.'
                                    : 'Stored encrypted on this computer; it is never shown again.'
                            }}</lib-hint>
                        </lib-form-field>
                        @if (!store.snapshot()?.secureStorageAvailable) {
                            <p class="muted">
                                This computer has no secure storage, so a secret cannot be saved here.
                            </p>
                        }
                        <div class="row">
                            <button libBtn="primary" appearance="filled" type="submit" [disabled]="!secretEntered()">
                                Save secret
                            </button>
                            @if (settings.hasSecret) {
                                <button libBtn="warn" appearance="text" type="button" (click)="forgetSecret()">
                                    Forget secret
                                </button>
                            }
                        </div>
                    </form>

                    <lib-slide-toggle [checked]="settings.safeMode" (change)="store.updateSettings({ safeMode: $event })">
                        Safe mode (simulate every command; touch nothing)
                    </lib-slide-toggle>
                    <lib-slide-toggle
                        [checked]="settings.startWithWindows"
                        (change)="store.updateSettings({ startWithWindows: $event })">
                        Start with Windows (in the tray)
                    </lib-slide-toggle>

                    <p class="muted">
                        Closing this window keeps brobot running in the tray, by the clock in the taskbar. To stop
                        it, right-click the tray icon and choose Quit.
                    </p>

                    <div class="stack">
                        <p>
                            Version {{ store.snapshot()?.version }}.
                            @if (updateLine(); as line) {
                                {{ line }}
                            }
                        </p>
                        <div class="row">
                            @if (canUpdate()) {
                                <button
                                    libBtn="secondary"
                                    appearance="outlined"
                                    type="button"
                                    [disabled]="checking()"
                                    (click)="store.checkForUpdate()">
                                    {{ checking() ? 'Checking…' : 'Check for updates' }}
                                </button>
                            } @else if (store.update()?.phase === 'unsupported') {
                                <a [href]="releasesUrl" target="_blank" rel="noopener">Download the latest brobot</a>
                            }
                        </div>
                    </div>
                }
            </lib-card-content>
        </lib-card>
    `,
})
export class SettingsPanelComponent {
    protected readonly store = inject(ClientStore);

    /** Set by the shell while setup is incomplete: this panel leads, with an introduction. */
    readonly firstRun = input(false);

    protected readonly serverUrl = new FormControl('', { nonNullable: true, validators: [serverUrlValidator] });
    protected readonly secret = new FormControl('', { nonNullable: true });

    private readonly serverValue = signal('');
    private readonly secretValue = signal('');

    protected readonly serverUrlError = computed(() => {
        this.serverValue();
        const errors = this.serverUrl.errors;
        return typeof errors?.['serverUrl'] === 'string' ? errors['serverUrl'] : '';
    });

    protected readonly serverDirty = computed(
        () => this.serverValue() !== (this.store.settings()?.serverUrl ?? '') && this.serverUrlError() === '',
    );

    protected readonly secretEntered = computed(() => this.secretValue().trim() !== '');

    protected readonly releasesUrl = RELEASES_URL;

    protected readonly canUpdate = computed(() => {
        const phase = this.store.update()?.phase;
        return phase !== undefined && phase !== 'unsupported';
    });

    protected readonly checking = computed(() => this.store.update()?.phase === 'checking');

    /** One sentence on where updates stand, after the version number. */
    protected readonly updateLine = computed((): string | null => {
        const status = this.store.update();
        if (status === null) return null;
        if (status.phase === 'unsupported') return status.unsupportedReason;
        if (status.lastError !== null && status.phase !== 'downloading') return status.lastError;
        if (status.update !== null) return `brobot ${status.update.version} is available.`;
        if (status.lastCheckedAt !== null) {
            return `Up to date (checked ${formatAgo(this.store.now() - status.lastCheckedAt)}).`;
        }
        return 'brobot looks for updates by itself a minute after it starts, then every four hours.';
    });

    constructor() {
        this.serverUrl.valueChanges.subscribe(value => this.serverValue.set(value));
        this.secret.valueChanges.subscribe(value => this.secretValue.set(value));

        // Show the saved address until the streamer starts typing their own.
        effect(() => {
            const saved = this.store.settings()?.serverUrl;
            if (saved !== undefined && !this.serverUrl.dirty) {
                this.serverUrl.setValue(saved);
            }
        });
    }

    protected async saveServer(event: Event): Promise<void> {
        event.preventDefault();
        if (this.serverUrl.invalid) {
            this.serverUrl.markAsTouched();
            return;
        }
        if (await this.store.updateSettings({ serverUrl: this.serverUrl.value })) {
            this.serverUrl.markAsPristine();
            this.serverUrl.setValue(this.store.settings()?.serverUrl ?? this.serverUrl.value);
        }
    }

    protected async saveSecret(event: Event): Promise<void> {
        event.preventDefault();
        if (!this.secretEntered()) return;
        if (await this.store.setSecret(this.secret.value)) {
            this.secret.reset('');
        }
    }

    protected async forgetSecret(): Promise<void> {
        await this.store.setSecret('');
    }
}
