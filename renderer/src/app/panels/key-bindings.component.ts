import {
    ChangeDetectionStrategy,
    Component,
    DestroyRef,
    Injector,
    afterNextRender,
    computed,
    effect,
    inject,
    signal,
    viewChild,
    type ElementRef,
} from '@angular/core';
import {
    BINDING_LABEL,
    CAPTURE_TIMEOUT_MS,
    DEFAULT_KEY_BINDINGS,
    PRESSED_BINDINGS,
    STREAMER_HOTKEYS,
    captureCombo,
    describeCombo,
    isPressedBinding,
    type KeyBindingId,
    type KeyComboSetting,
} from '@brobot-client/shared';
import { LibAlertBannerComponent, LibBtnDirective } from '@singularity/ngx-ui';
import { ClientStore } from '../core/client.store';
import { describeShortcut, overlayNotice, pressedReminder } from '../core/describe';

/** A change in progress: waiting for keys, or waiting for the streamer to confirm. */
type Edit =
    | { readonly id: KeyBindingId; readonly phase: 'capture'; readonly message: string | null }
    | {
          readonly id: KeyBindingId;
          readonly phase: 'confirm';
          readonly combo: KeyComboSetting;
          /** Reasons it cannot be saved: only Cancel is offered. */
          readonly errors: readonly string[];
          readonly warnings: readonly string[];
          /** For a voiceban key: Streamlabs/OBS has to change with it. */
          readonly notice: string | null;
      };

const DESCRIPTION: Readonly<Record<KeyBindingId, string>> = {
    create_marker: 'Puts a stream marker on the Twitch VOD.',
    create_prediction: 'Starts the channel prediction.',
    play_ad: 'Runs a 30 s ad break.',
    voiceban_start: 'Pressed as a voiceban starts.',
    voiceban_end: 'Pressed as a voiceban ends, however it ends.',
};

/**
 * Settings → Key bindings: every key brobot listens for or presses, with
 * Change (captures the next combination; Esc cancels), Reset, Off and Test.
 * Changes go through the same rules as the main process, and a voiceban key
 * is only saved after the streamer has seen that Streamlabs/OBS must change
 * with it.
 */
@Component({
    selector: 'app-key-bindings',
    standalone: true,
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [LibAlertBannerComponent, LibBtnDirective],
    styles: `
        .group {
            display: flex;
            flex-direction: column;
            gap: 0.5rem;
        }
        .group__title {
            font: var(--ui-title-small);
            margin: 0;
        }
        .binding {
            display: flex;
            flex-direction: column;
            gap: 0.375rem;
            padding-block: 0.625rem;
            border-top: 1px solid var(--ui-outline-variant);
        }
        .binding__head {
            display: flex;
            align-items: baseline;
            justify-content: space-between;
            gap: 0.75rem;
        }
        .binding__label {
            font-weight: 600;
        }
        .binding__combo {
            font: var(--ui-label-large);
            font-variant-numeric: tabular-nums;
            padding: 0.125rem 0.5rem;
            border: 1px solid var(--ui-outline);
            border-radius: var(--ui-radius-sm, 4px);
            background: var(--ui-surface-container);
            white-space: nowrap;
        }
        .binding__problem {
            color: var(--ui-error);
            font-weight: 600;
        }
        .binding__capture {
            display: flex;
            flex-direction: column;
            gap: 0.375rem;
            padding: 0.75rem;
            border: 2px dashed var(--ui-primary);
            border-radius: var(--ui-radius-sm, 4px);
        }
        .binding__message {
            color: var(--ui-error);
        }
    `,
    template: `
        <section class="stack" aria-labelledby="key-bindings-title">
            <h3 class="group__title" id="key-bindings-title">Key bindings</h3>

            @for (group of groups(); track group.title) {
                <div class="group">
                    <h4 class="group__title">{{ group.title }}</h4>
                    <p class="muted">{{ group.intro }}</p>
                    @for (row of group.rows; track row.id) {
                        <div class="binding" role="group" [attr.aria-labelledby]="'binding-' + row.id">
                            <div class="binding__head">
                                <span class="binding__label" [id]="'binding-' + row.id">{{ row.label }}</span>
                                <kbd class="binding__combo" [attr.aria-label]="row.label + ' key: ' + row.shown">{{ row.shown }}</kbd>
                            </div>
                            <p class="muted">{{ row.description }}</p>
                            @if (row.status; as status) {
                                <p [class.binding__problem]="status.problem" [class.muted]="!status.problem">
                                    {{ status.problem ? 'Warning: ' : '' }}{{ status.text }}
                                </p>
                            }

                            @if (edit(); as current) {
                                @if (current.id === row.id) {
                                    @if (current.phase === 'capture') {
                                        <div
                                            #capture
                                            class="binding__capture"
                                            tabindex="0"
                                            role="group"
                                            [attr.aria-label]="'New key for ' + row.label + '. Press it now; Escape cancels.'"
                                            (keydown)="onKey($event)">
                                            <p>Press the new keys for {{ row.label }} now. Esc cancels.</p>
                                            @if (current.message; as message) {
                                                <p class="binding__message" role="alert">{{ message }}</p>
                                            }
                                            <p class="muted">
                                                If nothing happens when you press it, another app is keeping that
                                                combination for itself.
                                            </p>
                                        </div>
                                        <div class="row">
                                            <button libBtn="secondary" appearance="text" type="button" (click)="finish()">
                                                Cancel
                                            </button>
                                        </div>
                                    } @else {
                                        <div #confirm class="stack" (keydown.escape)="finish()">
                                            <lib-alert-banner [variant]="current.errors.length > 0 ? 'error' : 'warn'">
                                                <span libAlertTitle>
                                                    {{ current.errors.length > 0 ? 'Cannot use' : 'Change ' + row.label + ' to' }}
                                                    {{ shown(current.combo) }}{{ current.errors.length > 0 ? '' : '?' }}
                                                </span>
                                                @if (current.notice; as notice) {
                                                    <p libAlertDescription>{{ notice }}</p>
                                                }
                                                @for (line of current.errors; track line) {
                                                    <p>{{ line }}</p>
                                                }
                                                @for (line of current.warnings; track line) {
                                                    <p>{{ line }}</p>
                                                }
                                            </lib-alert-banner>
                                            <div class="row">
                                                @if (current.errors.length === 0) {
                                                    <button
                                                        libBtn="primary"
                                                        appearance="filled"
                                                        type="button"
                                                        (click)="save(current.id, current.combo)">
                                                        Save
                                                    </button>
                                                }
                                                <button libBtn="secondary" appearance="text" type="button" (click)="finish()">
                                                    Cancel
                                                </button>
                                            </div>
                                        </div>
                                    }
                                }
                            }

                            <div class="row">
                                <button
                                    libBtn="secondary"
                                    appearance="outlined"
                                    type="button"
                                    [id]="'change-' + row.id"
                                    [disabled]="edit() !== null"
                                    (click)="change(row.id)">
                                    Change
                                </button>
                                <button
                                    libBtn="secondary"
                                    appearance="outlined"
                                    type="button"
                                    [disabled]="edit() !== null || (row.pressed && row.combo === 'none')"
                                    (click)="store.testBinding(row.id)">
                                    Test
                                </button>
                                @if (!row.isDefault) {
                                    <button
                                        libBtn="secondary"
                                        appearance="text"
                                        type="button"
                                        [disabled]="edit() !== null"
                                        (click)="propose(row.id, row.defaultCombo)">
                                        Reset to {{ row.defaultShown }}
                                    </button>
                                }
                                @if (row.combo !== 'none') {
                                    <button
                                        libBtn="secondary"
                                        appearance="text"
                                        type="button"
                                        [disabled]="edit() !== null"
                                        (click)="propose(row.id, 'none')">
                                        Off
                                    </button>
                                }
                            </div>
                        </div>
                    }
                </div>
            }
        </section>
    `,
})
export class KeyBindingsComponent {
    protected readonly store = inject(ClientStore);

    protected readonly edit = signal<Edit | null>(null);

    private readonly injector = inject(Injector);
    private readonly captureZone = viewChild<ElementRef<HTMLElement>>('capture');
    private readonly confirmZone = viewChild<ElementRef<HTMLElement>>('confirm');

    /** Whether this window asked the host to let go of the shortcuts. */
    private capturing = false;
    /** Gives up on a capture just before the host takes the shortcuts back. */
    private captureTimer: ReturnType<typeof setTimeout> | null = null;
    /** Bumped whenever a change starts or ends, so a late check answer is dropped. */
    private generation = 0;
    /** A check is on its way: further keys wait for it. */
    private checking = false;

    protected readonly groups = computed(() => {
        const bindings = this.store.settings()?.keyBindings ?? DEFAULT_KEY_BINDINGS;
        const shortcuts = this.store.snapshot()?.shortcuts;
        const row = (id: KeyBindingId) => {
            const combo = bindings[id];
            const pressed = isPressedBinding(id);
            const shortcut = pressed ? undefined : shortcuts?.[id];
            return {
                id,
                label: BINDING_LABEL[id],
                description: DESCRIPTION[id],
                combo,
                shown: describeCombo(combo),
                pressed,
                status: isPressedBinding(id)
                    ? { text: pressedReminder(id, combo), problem: false }
                    : shortcut === undefined
                      ? null
                      : describeShortcut(shortcut),
                isDefault: combo === DEFAULT_KEY_BINDINGS[id],
                defaultCombo: DEFAULT_KEY_BINDINGS[id],
                defaultShown: describeCombo(DEFAULT_KEY_BINDINGS[id]),
            };
        };
        return [
            {
                title: 'Shortcuts you press',
                intro:
                    'Each one asks brobot to do it on Twitch, from any app or game. Test sends it for real ' +
                    '(an ad test runs a real ad); in Safe mode it is only logged.',
                rows: STREAMER_HOTKEYS.map(row),
            },
            {
                title: 'Keys brobot presses for Streamlabs/OBS',
                intro:
                    'brobot presses these to switch the voiceban overlay. Streamlabs/OBS must have the same keys ' +
                    'bound (Streamlabs → Settings → Hotkeys, or OBS → Settings → Hotkeys). Test presses the key once.',
                rows: PRESSED_BINDINGS.map(row),
            },
        ];
    });

    constructor() {
        // The capture zone takes the focus as it appears, so the next key goes
        // to it; a confirmation puts it on its first button.
        effect(() => this.captureZone()?.nativeElement.focus());
        effect(() => this.confirmZone()?.nativeElement.querySelector('button')?.focus());
        inject(DestroyRef).onDestroy(() => {
            this.clearCaptureTimer();
            if (this.capturing) void this.store.captureKeys(false);
        });
    }

    protected shown(combo: KeyComboSetting): string {
        return describeCombo(combo);
    }

    protected async change(id: KeyBindingId): Promise<void> {
        this.generation++;
        this.edit.set({ id, phase: 'capture', message: null });
        // Registered shortcuts never reach the window: pressing Ctrl+Alt+F5 to
        // keep it would create a marker instead. The host takes them back after
        // a minute whatever happens, so the window stops listening first: a
        // capture still open then would let the next press fire the shortcut.
        this.capturing = true;
        this.clearCaptureTimer();
        this.captureTimer = setTimeout(() => {
            this.captureTimer = null;
            if (this.edit()?.phase === 'capture') void this.finish();
        }, CAPTURE_TIMEOUT_MS - 5000);
        await this.store.captureKeys(true);
    }

    protected async onKey(event: KeyboardEvent): Promise<void> {
        const edit = this.edit();
        if (edit?.phase !== 'capture') return;
        // Tab is no binding key: let it move the focus (to Cancel), so the
        // capture is never a keyboard trap.
        if (event.code === 'Tab' && !event.ctrlKey && !event.altKey) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.repeat || this.checking) return;
        const result = captureCombo(event);
        switch (result.kind) {
            case 'waiting':
                return;
            case 'cancel':
                await this.finish();
                return;
            case 'refused':
                this.edit.set({ ...edit, message: result.reason });
                return;
            case 'combo':
                await this.propose(edit.id, result.combo);
        }
    }

    /**
     * A new combination for `id`, from a capture or from Reset / Off: saved at
     * once when nothing needs saying, confirmed first when something does.
     */
    protected async propose(id: KeyBindingId, combo: KeyComboSetting): Promise<void> {
        if (this.store.settings()?.keyBindings[id] === combo) {
            await this.finish();
            return;
        }
        const generation = this.generation;
        this.checking = true;
        const check = await this.store.checkBinding(id, combo).finally(() => (this.checking = false));
        // Cancelled (or another change begun) while the host was answering.
        if (generation !== this.generation) return;
        if (check === null) {
            await this.finish();
            return;
        }
        const capturing = this.edit()?.phase === 'capture';
        if (check.errors.length > 0 && capturing) {
            // Let them try another without starting over.
            this.edit.set({ id, phase: 'capture', message: check.errors.join(' ') });
            return;
        }
        const notice = isPressedBinding(id) ? overlayNotice(id, combo) : null;
        if (check.errors.length === 0 && check.warnings.length === 0 && notice === null) {
            await this.save(id, combo);
            return;
        }
        this.edit.set({ id, phase: 'confirm', combo, errors: check.errors, warnings: check.warnings, notice });
    }

    protected async save(id: KeyBindingId, combo: KeyComboSetting): Promise<void> {
        this.checking = true;
        await this.store.updateSettings({ keyBindings: { [id]: combo } }).finally(() => (this.checking = false));
        await this.finish();
    }

    /** Ends the change, saved or not, and gives the shortcuts back. */
    protected async finish(): Promise<void> {
        const id = this.edit()?.id;
        this.generation++;
        this.clearCaptureTimer();
        this.edit.set(null);
        if (this.capturing) {
            this.capturing = false;
            await this.store.captureKeys(false);
        }
        // Back where the change started, once the button is enabled again.
        if (id !== undefined) {
            afterNextRender(() => document.getElementById(`change-${id}`)?.focus(), { injector: this.injector });
        }
    }

    private clearCaptureTimer(): void {
        if (this.captureTimer !== null) clearTimeout(this.captureTimer);
        this.captureTimer = null;
    }
}
