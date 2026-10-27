import { describe, expect, it } from 'vitest';
import { BINDING_KEYS } from '@brobot-client/shared';
import {
    blockEnterScript,
    encodePowerShellCommand,
    isDeviceId,
    keyCodeOf,
    muteMicrophoneScript,
    powershellArgs,
    unmuteScript,
} from './powershell-shim';

const KEYS = { start: 'F8', end: 'F9' } as const;

function decode(encoded: string): string {
    const binary = atob(encoded);
    let text = '';
    for (let i = 0; i < binary.length; i += 2) {
        text += String.fromCharCode(binary.charCodeAt(i) | (binary.charCodeAt(i + 1) << 8));
    }
    return text;
}

/** The C# between the here-string markers. */
function csharpOf(script: string): string {
    return script.slice(script.indexOf("@'\n") + 3, script.indexOf("\n'@"));
}

describe('the PowerShell shim', () => {
    it('encodes as UTF-16LE base64, as -EncodedCommand expects', () => {
        expect(encodePowerShellCommand('ab')).toBe('YQBiAA==');
        const script = blockEnterScript(1000, 99);
        expect(decode(encodePowerShellCommand(script))).toBe(script);
    });

    it('fits the Windows command-line limit with room to spare', () => {
        for (const script of [blockEnterScript(900_000, 123456), muteMicrophoneScript(900_000, 123456, KEYS)]) {
            const commandLine = ['powershell.exe', ...powershellArgs(script)].join(' ');
            expect(commandLine.length).toBeLessThan(30_000);
            expect(script).not.toMatch(/^\/\//m); // comments are stripped before sending
        }
    });

    it('closes the here-string on a line of its own, as PowerShell requires', () => {
        const lines = blockEnterScript(1000, 1).split('\n');
        expect(lines).toContain("Add-Type -TypeDefinition @'");
        expect(lines).toContain("'@");
        expect(lines.at(-1)).toBe('exit [Brobot.Shim]::BlockEnter(1000, 1)');
    });

    it('interpolates the protocol words and nothing else', () => {
        const csharp = csharpOf(muteMicrophoneScript(1000, 1, KEYS));
        expect(csharp).toContain('Say("READY")');
        expect(csharp).toContain('Say("MUTED " + id)');
        expect(csharp).not.toContain('${');
        // No here-string terminator inside the C#, or PowerShell would end it early.
        expect(csharp).not.toMatch(/^'@/m);
    });

    it('stays within C# 5, which is what Windows PowerShell compiles', () => {
        const csharp = csharpOf(blockEnterScript(1000, 1));
        expect(csharp).not.toMatch(/\$"/); // string interpolation (C# 6)
        expect(csharp).not.toMatch(/\?\./); // null-conditional (C# 6)
        expect(csharp).not.toMatch(/\)\s*=>/); // expression-bodied members / lambdas-as-bodies (C# 6)
        expect(csharp).not.toMatch(/\bnameof\(/); // C# 6
    });

    it('swallows only Enter key-down, and only while the hook is installed', () => {
        const csharp = csharpOf(blockEnterScript(1000, 1));
        expect(csharp).toContain('vkCode == VK_RETURN && (message == WM_KEYDOWN || message == WM_SYSKEYDOWN)');
        expect(csharp).toContain('UnhookWindowsHookEx(hook)');
    });

    it('rejects durations and pids that are not numbers it can print', () => {
        expect(() => blockEnterScript(Number.NaN, 1)).toThrow();
        expect(() => blockEnterScript(1000, 0)).toThrow();
        expect(() => muteMicrophoneScript(-1, 1, KEYS)).toThrow();
        expect(blockEnterScript(1000.6, 1)).toContain('BlockEnter(1001, 1)');
    });

    it('quotes only real Core Audio device ids into the unmute script', () => {
        const id = '{0.0.1.00000000}.{8f1c2a3b-0000-4000-8000-000000000001}';
        expect(isDeviceId(id)).toBe(true);
        expect(unmuteScript([id], 'none')).toContain(`Unmute([string[]]@('${id}'), 0)`);
        expect(isDeviceId("x'); Remove-Item")).toBe(false);
        expect(() => unmuteScript(["x'); Remove-Item"], 'none')).toThrow();
    });

    it('passes the overlay keys as Windows virtual-key codes, 0 for none', () => {
        expect(keyCodeOf('F1')).toBe(0x70);
        expect(keyCodeOf('F8')).toBe(0x77);
        expect(keyCodeOf('F9')).toBe(0x78);
        expect(keyCodeOf('F24')).toBe(0x87);
        expect(keyCodeOf('none')).toBe(0);
        expect(() => keyCodeOf('Enter')).toThrow();
        expect(muteMicrophoneScript(1000, 1, KEYS).split('\n').at(-1)).toBe(
            'exit [Brobot.Shim]::MuteMicrophone(1000, 1, 119, 120)',
        );
        expect(muteMicrophoneScript(1000, 1, { start: 'none', end: 'none' })).toContain('MuteMicrophone(1000, 1, 0, 0)');
        expect(unmuteScript([], 'F9')).toContain('Unmute([string[]]@(), 120)');
    });

    it('adds a bit for each modifier held around the key, and one for an extended key', () => {
        expect(keyCodeOf('Ctrl+A')).toBe(0x41 | 0x100);
        expect(keyCodeOf('Ctrl+Alt+F8')).toBe(0x77 | 0x100 | 0x200);
        expect(keyCodeOf('Alt+Shift+7')).toBe(0x37 | 0x200 | 0x400);
        expect(keyCodeOf('Alt+num7')).toBe(0x67 | 0x200);
        expect(keyCodeOf('Ctrl+numdiv')).toBe(0x6f | 0x100 | 0x800);
        expect(keyCodeOf('Ctrl+Up')).toBe(0x26 | 0x100 | 0x800);
        expect(keyCodeOf('Ctrl+Space')).toBe(0x20 | 0x100);
        // Every key a binding may use has a code.
        for (const key of BINDING_KEYS) expect(keyCodeOf(`Ctrl+${key}`) & 0xff).toBeGreaterThan(0);

        const csharp = csharpOf(muteMicrophoneScript(1000, 1, KEYS));
        const press = csharp.slice(csharp.indexOf('private static void PressKey('), csharp.indexOf('private const int eCapture'));
        // Modifiers down before the key and up after it, even when the key was refused.
        expect(press.indexOf('SendKey(ModifierVks[i], false, false)')).toBeLessThan(press.indexOf('SendKey(vk, false, extended)'));
        expect(press.indexOf('SendKey(vk, true, extended)')).toBeLessThan(press.indexOf('SendKey(held[i], true, false)'));
        expect(press.indexOf('SendKey(held[i], true, false)')).toBeLessThan(press.indexOf('if (error != 0)'));
        expect(csharp).toContain('KEYEVENTF_EXTENDEDKEY = 0x0001');
        expect(csharp).toContain('new int[] { 0x11, 0x12, 0x10 }');
    });

    it('presses the start key once muted and the end key once restored, on every way out', () => {
        const csharp = csharpOf(muteMicrophoneScript(1000, 1, KEYS));
        const mute = csharp.slice(csharp.indexOf('public static int MuteMicrophone('), csharp.indexOf('public static int Unmute('));
        // Start: after the devices are muted, before READY.
        expect(mute.indexOf('volume.SetMute(true')).toBeLessThan(mute.indexOf('PressKey(startVk, "START")'));
        expect(mute.indexOf('PressKey(startVk, "START")')).toBeLessThan(mute.indexOf('Say("READY")'));
        // End: after Stop.WaitOne, which returns on the duration, a "stop" line
        // (Stop / Release / the app quitting) or the app's process gone.
        expect(mute.indexOf('Stop.WaitOne(milliseconds)')).toBeLessThan(mute.indexOf('volume.SetMute(false'));
        expect(mute.indexOf('volume.SetMute(false')).toBeLessThan(mute.indexOf('PressKey(endVk, "END")'));
        expect(mute.indexOf('PressKey(endVk, "END")')).toBeLessThan(mute.indexOf('Say("DONE")'));
        // The fallback after a kill presses it too.
        const unmute = csharp.slice(csharp.indexOf('public static int Unmute('));
        expect(unmute).toContain('PressKey(endVk, "END")');
        // A real press: key down, held, key up.
        expect(csharp).toContain('Say("PRESSED " + when)');
        expect(csharp).toContain('Say("NOT PRESSED " + when');
        expect(csharp).toContain('SendInput(1, input, Marshal.SizeOf(typeof(INPUT)))');
        expect(csharp).toContain('Thread.Sleep(KEY_HOLD_MS)');
    });
});
