/**
 * Key bindings: the shortcuts the streamer presses (marker, prediction, ad —
 * each sent to brobot) and the keys brobot presses for the stream software
 * (the voiceban overlay on and off). One notation for all five, one set of
 * rules for what a binding may be, and the capture of a combination from a
 * key press in the window.
 *
 * A combination is written the way Electron's accelerators are — `Ctrl+Alt+F5`,
 * modifiers first in the order Ctrl, Alt, Shift — so the same string goes to
 * `globalShortcut.register` unchanged, is what the settings file stores, and
 * is (nearly) what the window shows.
 */

import { STREAMER_HOTKEYS, type StreamerHotkey } from './streamer-events';

/** A combination such as `Ctrl+Alt+F5`, in the canonical form {@link formatCombo} writes. */
export type KeyCombo = string;

/** A combination, or `'none'`: the binding is off. */
export type KeyComboSetting = KeyCombo | 'none';

export const MODIFIERS = ['Ctrl', 'Alt', 'Shift'] as const;
export type Modifier = (typeof MODIFIERS)[number];

const FUNCTION_KEYS = Array.from({ length: 24 }, (_, i) => `F${i + 1}`);
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
const DIGITS = '0123456789'.split('');
const NUMPAD = [...DIGITS.map(d => `num${d}`), 'numadd', 'numsub', 'nummult', 'numdiv', 'numdec'];
const NAVIGATION = ['Insert', 'Delete', 'Home', 'End', 'PageUp', 'PageDown', 'Up', 'Down', 'Left', 'Right'];

/**
 * The keys a binding may end in, by their Electron accelerator names. Enter,
 * Tab, Backspace and Escape are left out on purpose: Enter is what a chat ban
 * blocks, and the others are the window's own (Escape cancels a capture).
 */
export const BINDING_KEYS: readonly string[] = [...FUNCTION_KEYS, ...LETTERS, ...DIGITS, ...NUMPAD, ...NAVIGATION, 'Space'];

export interface ParsedCombo {
    readonly modifiers: readonly Modifier[];
    readonly key: string;
}

/** `ctrl+alt+f5`, `Alt+Ctrl+F5` → `{ modifiers: ['Ctrl', 'Alt'], key: 'F5' }`; null for anything else. */
export function parseCombo(text: string): ParsedCombo | null {
    const parts = text.split('+').map(p => p.trim());
    const keyName = parts.pop() ?? '';
    const key = BINDING_KEYS.find(k => k.toLowerCase() === keyName.toLowerCase());
    if (key === undefined) return null;
    const modifiers: Modifier[] = [];
    for (const part of parts) {
        const modifier = MODIFIERS.find(m => m.toLowerCase() === part.toLowerCase());
        if (modifier === undefined || modifiers.includes(modifier)) return null;
        modifiers.push(modifier);
    }
    return { modifiers: MODIFIERS.filter(m => modifiers.includes(m)), key };
}

export function formatCombo(combo: ParsedCombo): KeyCombo {
    return [...MODIFIERS.filter(m => combo.modifiers.includes(m)), combo.key].join('+');
}

/** A stored or sent value as a canonical setting, or null when it is not one. */
export function normalizeComboSetting(value: unknown): KeyComboSetting | null {
    if (value === 'none') return 'none';
    if (typeof value !== 'string' || value.length > 64) return null;
    const parsed = parseCombo(value);
    return parsed === null ? null : formatCombo(parsed);
}

const NUMPAD_NAMES: Readonly<Partial<Record<string, string>>> = {
    numadd: 'Num +',
    numsub: 'Num -',
    nummult: 'Num *',
    numdiv: 'Num /',
    numdec: 'Num .',
};

/** What the window and the log show: `Ctrl+Alt+F5`, `Ctrl+Num 1`, `Off`. */
export function describeCombo(setting: KeyComboSetting): string {
    if (setting === 'none') return 'Off';
    const parsed = parseCombo(setting);
    if (parsed === null) return setting;
    const key = NUMPAD_NAMES[parsed.key] ?? parsed.key.replace(/^num(\d)$/, 'Num $1');
    return [...parsed.modifiers, key].join('+');
}

// ── the five bindings ──────────────────────────────────────────────────────

/** The keys brobot presses, for the stream software's voiceban overlay. */
export const PRESSED_BINDINGS = ['voiceban_start', 'voiceban_end'] as const;
export type PressedBinding = (typeof PRESSED_BINDINGS)[number];

/** Outgoing shortcuts are named after the event they send. */
export type KeyBindingId = StreamerHotkey | PressedBinding;

export const KEY_BINDING_IDS: readonly KeyBindingId[] = [...STREAMER_HOTKEYS, ...PRESSED_BINDINGS];

export type KeyBindings = Readonly<Record<KeyBindingId, KeyComboSetting>>;

/**
 * Ctrl+Alt+F5 / F4 / F7 are what the pre-rewrite client listened for; F8 and
 * F9 are what it pressed, and what Streamlabs has bound to the overlay.
 */
export const DEFAULT_KEY_BINDINGS: KeyBindings = {
    create_marker: 'Ctrl+Alt+F5',
    create_prediction: 'Ctrl+Alt+F4',
    play_ad: 'Ctrl+Alt+F7',
    voiceban_start: 'F8',
    voiceban_end: 'F9',
};

export const BINDING_LABEL: Readonly<Record<KeyBindingId, string>> = {
    create_marker: 'Marker',
    create_prediction: 'Prediction',
    play_ad: 'Ad',
    voiceban_start: 'Voiceban start',
    voiceban_end: 'Voiceban end',
};

export function isKeyBindingId(value: unknown): value is KeyBindingId {
    return (KEY_BINDING_IDS as readonly unknown[]).includes(value);
}

export function isPressedBinding(id: KeyBindingId): id is PressedBinding {
    return (PRESSED_BINDINGS as readonly string[]).includes(id);
}

/**
 * The keys a voiceban presses as it starts and as it ends. Streamlabs Desktop
 * (or OBS) has them bound as hotkeys that show and hide the voiceban overlay;
 * the pre-rewrite client pressed F8 and F9 the same way.
 */
export interface VoicebanKeys {
    readonly start: KeyComboSetting;
    readonly end: KeyComboSetting;
}

export function voicebanKeysOf(bindings: KeyBindings): VoicebanKeys {
    return { start: bindings.voiceban_start, end: bindings.voiceban_end };
}

// ── the rules ──────────────────────────────────────────────────────────────

const ENTER_REFUSAL =
    'Enter is the key a chat ban blocks, and pressing it sends chat messages. Pick another key.';

/**
 * Shortcuts other software on a streaming PC has out of the box. OBS and
 * Streamlabs ship with no hotkeys bound, so their clashes are the streamer's
 * own; the voiceban keys are the ones brobot knows about, and those are
 * checked as duplicates instead.
 */
const KNOWN_SHORTCUTS: Readonly<Partial<Record<KeyCombo, string>>> = {
    'Ctrl+Shift+M': "Discord's Toggle Mute",
    'Ctrl+Shift+D': "Discord's Toggle Deafen",
    'Alt+Z': 'the NVIDIA overlay',
    'Alt+F1': "NVIDIA's screenshot",
    'Alt+F9': "NVIDIA's start/stop recording",
    'Alt+F10': "NVIDIA's save instant replay",
    'Alt+Shift+F10': "NVIDIA's instant replay on/off",
    'Alt+R': 'the NVIDIA and AMD performance overlay',
    'Ctrl+Shift+E': "AMD's start/stop recording",
    'Ctrl+Shift+S': "AMD's save instant replay",
    'Ctrl+Shift+I': "AMD's screenshot",
    'Ctrl+Shift+O': "AMD's performance overlay",
    F12: "Steam's screenshot key",
    'Alt+Space': "Windows' window menu (and PowerToys Run)",
};

/** Why a combination can never be a binding, or null when it can. */
export function refusalOf(combo: KeyCombo): string | null {
    if (/(^|\+)\s*(enter|return)\s*$/i.test(combo)) return ENTER_REFUSAL;
    const parsed = parseCombo(combo);
    if (parsed === null) return `brobot does not know the key combination "${combo}".`;
    const held = parsed.modifiers.includes('Ctrl') || parsed.modifiers.includes('Alt');
    if (!held && !FUNCTION_KEYS.includes(parsed.key)) {
        const what = describeCombo(formatCombo(parsed));
        return `${what} is a key you type or play with, so it would go off by accident. Add Ctrl or Alt, or use an F key.`;
    }
    if (formatCombo(parsed) === 'Alt+F4') return 'Alt+F4 closes the window in front. Pick another.';
    return null;
}

export interface BindingCheck {
    /** Reasons it cannot be saved. */
    readonly errors: readonly string[];
    /** Reasons to think twice: it may be saved anyway. */
    readonly warnings: readonly string[];
}

/**
 * Whether `combo` may become binding `id`, given the others in `bindings`:
 * refused combinations and duplicates are errors (a voiceban key equal to a
 * shortcut would fire the shortcut every voiceban), clashes with common
 * software defaults are warnings.
 */
export function checkBinding(id: KeyBindingId, combo: KeyComboSetting, bindings: KeyBindings): BindingCheck {
    if (combo === 'none') return { errors: [], warnings: [] };
    const errors: string[] = [];
    const warnings: string[] = [];
    const refusal = refusalOf(combo);
    if (refusal !== null) return { errors: [refusal], warnings };
    const canonical = normalizeComboSetting(combo) ?? combo;
    const shown = describeCombo(canonical);
    for (const other of KEY_BINDING_IDS) {
        // The two voiceban keys may be one key: a hotkey that toggles the
        // overlay. Nothing listens for them, so they cannot set each other off.
        if (isPressedBinding(id) && isPressedBinding(other)) continue;
        if (other !== id && bindings[other] === canonical) {
            errors.push(`${shown} is already the ${BINDING_LABEL[other]} key. Each binding needs its own.`);
        }
    }
    const clash = KNOWN_SHORTCUTS[canonical];
    if (clash !== undefined) {
        warnings.push(
            isPressedBinding(id)
                ? `${shown} is ${clash} by default, so brobot pressing it may set that off too.`
                : `${shown} is ${clash} by default, so pressing it may set that off too.`,
        );
    }
    return { errors, warnings };
}

/**
 * How long the main process lets go of the shortcuts for a key capture before
 * taking them back; the window gives up on the capture a little sooner.
 */
export const CAPTURE_TIMEOUT_MS = 60_000;

/** The first reason a whole set of bindings cannot be saved, or null. */
export function bindingsError(bindings: KeyBindings): string | null {
    for (const id of KEY_BINDING_IDS) {
        const error = checkBinding(id, bindings[id], bindings).errors.at(0);
        if (error !== undefined) return `${BINDING_LABEL[id]}: ${error}`;
    }
    return null;
}

// ── capture ────────────────────────────────────────────────────────────────

/** The fields of a DOM `KeyboardEvent` capture reads. */
export interface KeyEventLike {
    readonly code: string;
    readonly ctrlKey: boolean;
    readonly altKey: boolean;
    readonly shiftKey: boolean;
    readonly metaKey: boolean;
}

export type CaptureResult =
    | { readonly kind: 'combo'; readonly combo: KeyCombo }
    /** Only modifiers so far: keep listening. */
    | { readonly kind: 'waiting' }
    /** Escape: stop without changing anything. */
    | { readonly kind: 'cancel' }
    | { readonly kind: 'refused'; readonly reason: string };

const MODIFIER_CODE = /^(Control|Alt|Shift|Meta|OS)(Left|Right)?$/;

const CODE_KEYS: Readonly<Partial<Record<string, string>>> = {
    NumpadAdd: 'numadd',
    NumpadSubtract: 'numsub',
    NumpadMultiply: 'nummult',
    NumpadDivide: 'numdiv',
    NumpadDecimal: 'numdec',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
};

/**
 * The binding key for a physical key (`KeyboardEvent.code`, so the same key
 * on any keyboard layout), or null when bindings cannot use it.
 */
function keyOfCode(code: string): string | null {
    if (FUNCTION_KEYS.includes(code)) return code;
    if (/^Key[A-Z]$/.test(code)) return code.slice('Key'.length);
    if (/^Digit\d$/.test(code)) return code.slice('Digit'.length);
    if (/^Numpad\d$/.test(code)) return `num${code.slice('Numpad'.length)}`;
    if (NAVIGATION.includes(code) || code === 'Space') return code;
    return CODE_KEYS[code] ?? null;
}

/** Reads one `keydown` while the window is waiting for a new combination. */
export function captureCombo(event: KeyEventLike): CaptureResult {
    if (event.code === 'Escape') return { kind: 'cancel' };
    if (MODIFIER_CODE.test(event.code)) return { kind: 'waiting' };
    if (event.metaKey) {
        return { kind: 'refused', reason: 'Windows keeps the Windows-key shortcuts for itself. Use Ctrl, Alt or Shift.' };
    }
    if (event.code === 'Enter' || event.code === 'NumpadEnter') return { kind: 'refused', reason: ENTER_REFUSAL };
    const key = keyOfCode(event.code);
    if (key === null) {
        return {
            kind: 'refused',
            reason: 'brobot cannot use that key. Use an F key, or a letter, number, numpad or arrow key with Ctrl or Alt.',
        };
    }
    const modifiers = MODIFIERS.filter(
        m => (m === 'Ctrl' && event.ctrlKey) || (m === 'Alt' && event.altKey) || (m === 'Shift' && event.shiftKey),
    );
    return { kind: 'combo', combo: formatCombo({ modifiers, key }) };
}
