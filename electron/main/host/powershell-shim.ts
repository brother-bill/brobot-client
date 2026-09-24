/**
 * The Windows half of HostControl: a small C# program compiled at run time by
 * Windows PowerShell's `Add-Type`, and run as a child process per action.
 *
 * ## Why not nut.js
 *
 * The migration plan suggested `@nut-tree-fork/nut-js` for the keyboard. It
 * cannot do this job: nut.js *synthesises* input (press, type, move), and a
 * chatban has to *suppress* it — the streamer presses Enter and nothing
 * receives it. Suppression needs a low-level keyboard hook
 * (`SetWindowsHookEx(WH_KEYBOARD_LL)`) that returns non-zero for Enter, which
 * is exactly what the 2022 Python script did through the `keyboard` package.
 * Microphone mute needs the Core Audio endpoint API (`IAudioEndpointVolume`),
 * which no maintained Node module wraps. Both are a few dozen lines of P/Invoke
 * and COM interop, and PowerShell 5.1 ships with every Windows 11 install — so
 * this needs no native Node module, no prebuilt binary per Electron ABI, no
 * Python, and nothing extra in the installer.
 *
 * ## Why a child process per action
 *
 * The hook lives exactly as long as the process that installed it. A block
 * cannot outlive its PowerShell: when it exits — duration over, told to stop,
 * killed, or the app crashed — Windows removes the hook. The mic shim restores
 * the mute state itself when it stops, and it stops when told to, when stdin
 * closes, or when it sees the app's process has gone; if it is killed outright,
 * `WindowsHostControl` runs {@link unmuteScript} with the device ids the shim
 * reported. A streamer is never left with a dead Enter key or a muted mic
 * because the app went away.
 *
 * The C# is restricted to C# 5: Windows PowerShell's `Add-Type` compiles with
 * the .NET Framework's CodeDom compiler, which predates string interpolation,
 * `?.` and expression-bodied members.
 */

/** Printed once the hook is installed / the mic is muted. */
export const SHIM_READY = 'READY';
/** Printed once the machine is back to normal. */
export const SHIM_DONE = 'DONE';
/** `MUTED <device id>`: a device this run muted and will unmute. */
export const SHIM_MUTED_PREFIX = 'MUTED ';

const CSHARP = String.raw`
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

namespace Brobot {

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
internal class MMDeviceEnumerator { }

[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IMMDeviceEnumerator {
    [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
    [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
    [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
}

[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IMMDevice {
    [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object endpoint);
    [PreserveSig] int OpenPropertyStore(int access, out IntPtr properties);
    [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
}

[ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IAudioEndpointVolume {
    [PreserveSig] int RegisterControlChangeNotify(IntPtr notify);
    [PreserveSig] int UnregisterControlChangeNotify(IntPtr notify);
    [PreserveSig] int GetChannelCount(out uint count);
    [PreserveSig] int SetMasterVolumeLevel(float level, ref Guid context);
    [PreserveSig] int SetMasterVolumeLevelScalar(float level, ref Guid context);
    [PreserveSig] int GetMasterVolumeLevel(out float level);
    [PreserveSig] int GetMasterVolumeLevelScalar(out float level);
    [PreserveSig] int SetChannelVolumeLevel(uint channel, float level, ref Guid context);
    [PreserveSig] int SetChannelVolumeLevelScalar(uint channel, float level, ref Guid context);
    [PreserveSig] int GetChannelVolumeLevel(uint channel, out float level);
    [PreserveSig] int GetChannelVolumeLevelScalar(uint channel, out float level);
    [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid context);
    [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
}

public static class Shim {
    private static readonly ManualResetEvent Stop = new ManualResetEvent(false);

    private static void Say(string line) {
        Console.Out.WriteLine(line);
        Console.Out.Flush();
    }

    // Ends the action early on a "stop" line, when stdin closes, or when the
    // app that started us is gone - a ban never outlives brobot.
    private static void WatchForStop(int parentPid) {
        Thread reader = new Thread(delegate() {
            try {
                string line;
                while ((line = Console.In.ReadLine()) != null) {
                    if (line.Trim() == "stop") break;
                }
            } catch (Exception) { }
            Stop.Set();
        });
        reader.IsBackground = true;
        reader.Start();
        Thread parent = new Thread(delegate() {
            while (!Stop.WaitOne(1000)) {
                try {
                    if (Process.GetProcessById(parentPid).HasExited) break;
                } catch (Exception) {
                    break;
                }
            }
            Stop.Set();
        });
        parent.IsBackground = true;
        parent.Start();
    }

    private delegate IntPtr LowLevelKeyboardProc(int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetWindowsHookEx(int idHook, LowLevelKeyboardProc lpfn, IntPtr hMod, uint dwThreadId);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool UnhookWindowsHookEx(IntPtr hhk);
    [DllImport("user32.dll")]
    private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")]
    private static extern int GetMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax);
    [DllImport("user32.dll")]
    private static extern bool PeekMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax, uint wRemoveMsg);
    [DllImport("user32.dll")]
    private static extern bool PostThreadMessage(uint idThread, uint msg, IntPtr wParam, IntPtr lParam);
    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr GetModuleHandle(string lpModuleName);

    [StructLayout(LayoutKind.Sequential)]
    private struct MSG {
        public IntPtr hwnd;
        public uint message;
        public IntPtr wParam;
        public IntPtr lParam;
        public uint time;
        public int x;
        public int y;
    }

    private const int WH_KEYBOARD_LL = 13;
    private const int WM_KEYDOWN = 0x0100;
    private const int WM_SYSKEYDOWN = 0x0104;
    private const int VK_RETURN = 0x0D;
    private const uint WM_QUIT = 0x0012;

    private static IntPtr hook = IntPtr.Zero;
    // Static so the GC cannot collect the delegate while Windows still calls it.
    private static LowLevelKeyboardProc keyboardProc;

    // KBDLLHOOKSTRUCT.vkCode is the first field. VK_RETURN covers both Enter
    // keys. Only key-DOWN is swallowed: a key held when the block starts must
    // still be able to come back up.
    private static IntPtr OnKeyboard(int nCode, IntPtr wParam, IntPtr lParam) {
        if (nCode >= 0) {
            long message = wParam.ToInt64();
            int vkCode = Marshal.ReadInt32(lParam);
            if (vkCode == VK_RETURN && (message == WM_KEYDOWN || message == WM_SYSKEYDOWN)) {
                return new IntPtr(1);
            }
        }
        return CallNextHookEx(hook, nCode, wParam, lParam);
    }

    public static int BlockEnter(int milliseconds, int parentPid) {
        MSG msg;
        // Give this thread its message queue before anything posts to it.
        PeekMessage(out msg, IntPtr.Zero, 0, 0, 0);
        keyboardProc = new LowLevelKeyboardProc(OnKeyboard);
        hook = SetWindowsHookEx(WH_KEYBOARD_LL, keyboardProc, GetModuleHandle(null), 0);
        if (hook == IntPtr.Zero) {
            Console.Error.WriteLine("Windows refused the keyboard hook (error " + Marshal.GetLastWin32Error() + ")");
            return 2;
        }
        Say("${SHIM_READY}");
        uint threadId = GetCurrentThreadId();
        WatchForStop(parentPid);
        Thread timer = new Thread(delegate() {
            Stop.WaitOne(milliseconds);
            PostThreadMessage(threadId, WM_QUIT, IntPtr.Zero, IntPtr.Zero);
        });
        timer.IsBackground = true;
        timer.Start();
        while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0) { }
        UnhookWindowsHookEx(hook);
        hook = IntPtr.Zero;
        Say("${SHIM_DONE}");
        return 0;
    }

    private const int eCapture = 1;
    private const int eConsole = 0;
    private const int eCommunications = 2;
    private const int CLSCTX_ALL = 23;

    private static IMMDeviceEnumerator Enumerator() {
        return (IMMDeviceEnumerator)(new MMDeviceEnumerator());
    }

    private static IAudioEndpointVolume VolumeOf(IMMDevice device) {
        Guid iid = typeof(IAudioEndpointVolume).GUID;
        object endpoint;
        if (device.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out endpoint) != 0) return null;
        return endpoint as IAudioEndpointVolume;
    }

    // Mutes the default recording device for both roles Windows keeps one for
    // (Console and Communications; usually the same device), remembering which
    // were not muted already, and restores exactly those.
    public static int MuteMicrophone(int milliseconds, int parentPid) {
        IMMDeviceEnumerator enumerator = Enumerator();
        List<string> seen = new List<string>();
        List<IAudioEndpointVolume> muted = new List<IAudioEndpointVolume>();
        int[] roles = new int[] { eConsole, eCommunications };
        Guid context = Guid.Empty;
        foreach (int role in roles) {
            IMMDevice device;
            if (enumerator.GetDefaultAudioEndpoint(eCapture, role, out device) != 0 || device == null) continue;
            string id;
            if (device.GetId(out id) != 0 || seen.Contains(id)) continue;
            seen.Add(id);
            IAudioEndpointVolume volume = VolumeOf(device);
            if (volume == null) continue;
            bool wasMuted;
            if (volume.GetMute(out wasMuted) != 0 || wasMuted) continue;
            if (volume.SetMute(true, ref context) != 0) continue;
            muted.Add(volume);
            Say("${SHIM_MUTED_PREFIX}" + id);
        }
        if (seen.Count == 0) {
            Console.Error.WriteLine("No default recording device is set in Windows sound settings");
            return 3;
        }
        Say("${SHIM_READY}");
        WatchForStop(parentPid);
        Stop.WaitOne(milliseconds);
        foreach (IAudioEndpointVolume volume in muted) {
            volume.SetMute(false, ref context);
        }
        Say("${SHIM_DONE}");
        return 0;
    }

    public static int Unmute(string[] ids) {
        IMMDeviceEnumerator enumerator = Enumerator();
        Guid context = Guid.Empty;
        int failures = 0;
        foreach (string id in ids) {
            IMMDevice device;
            if (enumerator.GetDevice(id, out device) != 0 || device == null) { failures++; continue; }
            IAudioEndpointVolume volume = VolumeOf(device);
            if (volume == null || volume.SetMute(false, ref context) != 0) failures++;
        }
        Say("${SHIM_DONE}");
        return failures == 0 ? 0 : 4;
    }
}
}
`;

/**
 * The C# with indentation stripped. The whole script travels base64-encoded
 * UTF-16 on the command line, which Windows caps at 32,767 characters; the
 * indentation alone is a fifth of it.
 */
const COMPACT_CSHARP = CSHARP.replace(/^[ \t]+/gm, '').trim();

function wrap(invocation: string): string {
    return [
        "$ErrorActionPreference = 'Stop'",
        "Add-Type -TypeDefinition @'",
        COMPACT_CSHARP,
        "'@",
        `exit ${invocation}`,
    ].join('\n');
}

function wholeMilliseconds(ms: number): number {
    if (!Number.isFinite(ms) || ms < 0) throw new Error(`invalid duration: ${ms}`);
    return Math.min(Math.round(ms), 2 ** 31 - 1);
}

function processId(pid: number): number {
    if (!Number.isInteger(pid) || pid <= 0) throw new Error(`invalid process id: ${pid}`);
    return pid;
}

export function blockEnterScript(durationMs: number, parentPid: number): string {
    return wrap(`[Brobot.Shim]::BlockEnter(${wholeMilliseconds(durationMs)}, ${processId(parentPid)})`);
}

export function muteMicrophoneScript(durationMs: number, parentPid: number): string {
    return wrap(`[Brobot.Shim]::MuteMicrophone(${wholeMilliseconds(durationMs)}, ${processId(parentPid)})`);
}

/**
 * Core Audio endpoint ids look like `{0.0.1.00000000}.{8f1c…}`. Anything else
 * did not come from the shim, and is refused rather than quoted into a script.
 */
const DEVICE_ID = /^[A-Za-z0-9{}.-]+$/;

export function isDeviceId(value: string): boolean {
    return DEVICE_ID.test(value);
}

export function unmuteScript(deviceIds: readonly string[]): string {
    for (const id of deviceIds) {
        if (!isDeviceId(id)) throw new Error(`refusing an unexpected device id: ${JSON.stringify(id)}`);
    }
    const list = deviceIds.map(id => `'${id}'`).join(',');
    return wrap(`[Brobot.Shim]::Unmute([string[]]@(${list}))`);
}

/**
 * The arguments for `powershell.exe`. `-EncodedCommand` rather than a `.ps1`
 * file: nothing to ship, nothing for the execution policy to refuse, and no
 * temp file for anything else to swap. `-InputFormat None` stops PowerShell
 * itself from reading stdin, which the shim reads for its "stop" line (and
 * without which PowerShell would wait for stdin to close before exiting).
 */
export function powershellArgs(script: string): string[] {
    return [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-InputFormat',
        'None',
        '-EncodedCommand',
        encodePowerShellCommand(script),
    ];
}

/** Base64 of the UTF-16LE bytes, which is what `-EncodedCommand` expects. */
export function encodePowerShellCommand(script: string): string {
    let binary = '';
    for (let i = 0; i < script.length; i++) {
        const unit = script.charCodeAt(i);
        binary += String.fromCharCode(unit & 0xff, unit >> 8);
    }
    return btoa(binary);
}
