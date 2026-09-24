import { describe, expect, it } from 'vitest';
import {
    blockEnterScript,
    encodePowerShellCommand,
    isDeviceId,
    muteMicrophoneScript,
    powershellArgs,
    unmuteScript,
} from './powershell-shim';

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
        for (const script of [blockEnterScript(900_000, 123456), muteMicrophoneScript(900_000, 123456)]) {
            const commandLine = ['powershell.exe', ...powershellArgs(script)].join(' ');
            expect(commandLine.length).toBeLessThan(30_000);
        }
    });

    it('closes the here-string on a line of its own, as PowerShell requires', () => {
        const lines = blockEnterScript(1000, 1).split('\n');
        expect(lines).toContain("Add-Type -TypeDefinition @'");
        expect(lines).toContain("'@");
        expect(lines.at(-1)).toBe('exit [Brobot.Shim]::BlockEnter(1000, 1)');
    });

    it('interpolates the protocol words and nothing else', () => {
        const csharp = csharpOf(muteMicrophoneScript(1000, 1));
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
        expect(() => muteMicrophoneScript(-1, 1)).toThrow();
        expect(blockEnterScript(1000.6, 1)).toContain('BlockEnter(1001, 1)');
    });

    it('quotes only real Core Audio device ids into the unmute script', () => {
        const id = '{0.0.1.00000000}.{8f1c2a3b-0000-4000-8000-000000000001}';
        expect(isDeviceId(id)).toBe(true);
        expect(unmuteScript([id])).toContain(`Unmute([string[]]@('${id}'))`);
        expect(isDeviceId("x'); Remove-Item")).toBe(false);
        expect(() => unmuteScript(["x'); Remove-Item"])).toThrow();
    });
});
