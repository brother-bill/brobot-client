import { describe, expect, it } from 'vitest';
import {
    DEFAULT_KEY_BINDINGS,
    bindingsError,
    captureCombo,
    checkBinding,
    describeCombo,
    normalizeComboSetting,
    parseCombo,
    refusalOf,
    type KeyEventLike,
} from './key-bindings';

const key = (code: string, mods: Partial<Omit<KeyEventLike, 'code'>> = {}): KeyEventLike => ({
    code,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ...mods,
});

describe('key combinations', () => {
    it('writes them as Electron accelerators, modifiers in one order', () => {
        expect(parseCombo('Ctrl+Alt+F5')).toEqual({ modifiers: ['Ctrl', 'Alt'], key: 'F5' });
        expect(normalizeComboSetting('alt+ctrl+f5')).toBe('Ctrl+Alt+F5');
        expect(normalizeComboSetting('Shift+Ctrl+NUM7')).toBe('Ctrl+Shift+num7');
        expect(normalizeComboSetting('none')).toBe('none');
    });

    it('refuses what it cannot press or register', () => {
        for (const bad of ['', 'Ctrl+', 'Ctrl+Ctrl+A', 'Win+A', 'Ctrl+Enter', 'Ctrl+Tab', 'F25', 'Hyper+F5', 42, null]) {
            expect(normalizeComboSetting(bad), String(bad)).toBeNull();
        }
    });

    it('shows them the way a streamer reads them', () => {
        expect(describeCombo('Ctrl+Alt+F5')).toBe('Ctrl+Alt+F5');
        expect(describeCombo('Ctrl+num1')).toBe('Ctrl+Num 1');
        expect(describeCombo('Alt+numadd')).toBe('Alt+Num +');
        expect(describeCombo('none')).toBe('Off');
    });
});

describe('capturing a combination from a key press', () => {
    it('reads the physical key with the modifiers held', () => {
        expect(captureCombo(key('F5', { ctrlKey: true, altKey: true }))).toEqual({ kind: 'combo', combo: 'Ctrl+Alt+F5' });
        expect(captureCombo(key('KeyM', { ctrlKey: true, shiftKey: true }))).toEqual({ kind: 'combo', combo: 'Ctrl+Shift+M' });
        expect(captureCombo(key('Digit3', { altKey: true }))).toEqual({ kind: 'combo', combo: 'Alt+3' });
        expect(captureCombo(key('Numpad7', { ctrlKey: true }))).toEqual({ kind: 'combo', combo: 'Ctrl+num7' });
        expect(captureCombo(key('NumpadAdd', { ctrlKey: true }))).toEqual({ kind: 'combo', combo: 'Ctrl+numadd' });
        expect(captureCombo(key('ArrowUp', { altKey: true }))).toEqual({ kind: 'combo', combo: 'Alt+Up' });
        expect(captureCombo(key('F8'))).toEqual({ kind: 'combo', combo: 'F8' });
    });

    it('keeps waiting while only modifiers are down, and Esc cancels', () => {
        expect(captureCombo(key('ControlLeft', { ctrlKey: true }))).toEqual({ kind: 'waiting' });
        expect(captureCombo(key('AltRight', { ctrlKey: true, altKey: true }))).toEqual({ kind: 'waiting' });
        expect(captureCombo(key('ShiftLeft', { shiftKey: true }))).toEqual({ kind: 'waiting' });
        expect(captureCombo(key('Escape'))).toEqual({ kind: 'cancel' });
        expect(captureCombo(key('Escape', { ctrlKey: true }))).toEqual({ kind: 'cancel' });
    });

    it('refuses Enter (the chat ban key), the Windows key and keys bindings cannot use, saying why', () => {
        const enter = captureCombo(key('Enter', { ctrlKey: true }));
        expect(enter.kind).toBe('refused');
        expect(enter.kind === 'refused' && enter.reason).toMatch(/chat ban/);
        expect(captureCombo(key('NumpadEnter')).kind).toBe('refused');
        expect(captureCombo(key('KeyA', { metaKey: true })).kind).toBe('refused');
        expect(captureCombo(key('Tab', { altKey: true })).kind).toBe('refused');
        expect(captureCombo(key('CapsLock')).kind).toBe('refused');
        expect(captureCombo(key('')).kind).toBe('refused');
    });
});

describe('the rules for a binding', () => {
    it('refuses keys you type or play with unless Ctrl or Alt is held', () => {
        for (const bad of ['A', 'Shift+A', '5', 'Space', 'Shift+Space', 'Up', 'num4', 'Delete']) {
            expect(refusalOf(bad), bad).toMatch(/Add Ctrl or Alt/);
        }
        for (const good of ['F8', 'Shift+F8', 'Ctrl+A', 'Alt+5', 'Ctrl+Space', 'Ctrl+Alt+Up', 'Alt+num4']) {
            expect(refusalOf(good), good).toBeNull();
        }
    });

    it('refuses Enter in any combination, and Alt+F4', () => {
        expect(refusalOf('Enter')).toMatch(/chat ban/);
        expect(refusalOf('Ctrl+Alt+Return')).toMatch(/chat ban/);
        expect(refusalOf('Alt+F4')).toMatch(/closes the window/);
        // The old client's Prediction key is fine: Ctrl is held too.
        expect(refusalOf('Ctrl+Alt+F4')).toBeNull();
    });

    it('allows the defaults as they are', () => {
        expect(bindingsError(DEFAULT_KEY_BINDINGS)).toBeNull();
    });

    it('refuses a duplicate across all five, but not the same binding kept', () => {
        expect(checkBinding('play_ad', 'F8', DEFAULT_KEY_BINDINGS).errors).toEqual([
            'F8 is already the Voiceban start key. Each binding needs its own.',
        ]);
        expect(checkBinding('voiceban_end', 'Ctrl+Alt+F5', DEFAULT_KEY_BINDINGS).errors[0]).toMatch(/Marker/);
        expect(checkBinding('create_marker', 'Ctrl+Alt+F5', DEFAULT_KEY_BINDINGS)).toEqual({ errors: [], warnings: [] });
        expect(checkBinding('create_marker', 'ctrl+alt+f4', DEFAULT_KEY_BINDINGS).errors[0]).toMatch(/Prediction/);
        expect(bindingsError({ ...DEFAULT_KEY_BINDINGS, play_ad: 'F9' })).toMatch(/^Ad: F9 is already the Voiceban end key/);
    });

    it('lets the two voiceban keys be one key (a toggle hotkey), but no shortcut share it', () => {
        const toggle = { ...DEFAULT_KEY_BINDINGS, voiceban_end: 'F8' };
        expect(checkBinding('voiceban_end', 'F8', DEFAULT_KEY_BINDINGS).errors).toEqual([]);
        expect(bindingsError(toggle)).toBeNull();
        expect(checkBinding('create_marker', 'F8', toggle).errors).toHaveLength(2);
    });

    it('lets any number of bindings be off', () => {
        const off = { ...DEFAULT_KEY_BINDINGS, create_marker: 'none', play_ad: 'none', voiceban_end: 'none' };
        expect(bindingsError(off)).toBeNull();
        expect(checkBinding('create_prediction', 'none', off)).toEqual({ errors: [], warnings: [] });
    });

    it('warns about combinations common streaming software has by default, for both kinds', () => {
        expect(checkBinding('create_marker', 'Ctrl+Shift+M', DEFAULT_KEY_BINDINGS).warnings).toEqual([
            "Ctrl+Shift+M is Discord's Toggle Mute by default, so pressing it may set that off too.",
        ]);
        expect(checkBinding('voiceban_start', 'Alt+F9', DEFAULT_KEY_BINDINGS).warnings).toEqual([
            "Alt+F9 is NVIDIA's start/stop recording by default, so brobot pressing it may set that off too.",
        ]);
        expect(checkBinding('play_ad', 'Ctrl+Alt+F11', DEFAULT_KEY_BINDINGS).warnings).toEqual([]);
    });
});
