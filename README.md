# brobot for Windows

brobot's app for the streamer's PC. It sits in the system tray, stays
connected to brobot, and when chat votes for it, it does the thing to this
computer:

- **!chatban** — blocks your **Enter** key for 5 minutes, so you cannot send
  chat messages.
- **!voiceban** — **mutes your microphone** for 30 seconds.

When the time is up it puts everything back and tells brobot, and chat can
vote again.

---

## For the streamer

### Install

1. Get `brobot-setup-<version>.exe` from the owner (or build it — see
   [Building the installer](#building-the-installer)).
2. Run it. Windows SmartScreen may say "Windows protected your PC", because
   the installer is not code-signed yet: choose **More info → Run anyway**.
3. Pick where to install (the default is fine). brobot opens when the
   installer finishes.

Prefer not to install? `brobot-portable-<version>.exe` runs from anywhere,
including a USB stick. Everything below works the same.

### First run

The window opens on **Set up brobot**:

1. **Server address** — leave `wss://admin.brobot.live/api/ashketchum` unless
   you were told otherwise. Click **Save address**.
2. **Secret** — paste the secret the brobot admin gave you and click
   **Save secret**. It is stored encrypted for your Windows account on this
   PC, and is never shown again.

The lamp at the top turns to **Connected**. From now on brobot **starts with
Windows**, straight into the tray (turn that off under Settings, or in the tray
menu).

Want to see it work first? Turn on **Safe mode** before saving the secret:
every command is logged but your keyboard and microphone are left alone.

### Where it lives

brobot's icon is in the **system tray**, next to the clock at the bottom-right
of the taskbar. If you do not see it, click the **^** arrow beside the clock —
Windows hides new tray icons there. To keep it visible, drag it out of that
panel onto the taskbar (or: Settings → Personalization → Taskbar → Other
system tray icons → brobot → On).

The icon tells you the state at a glance, by shape as well as colour:

| Icon | Means |
|---|---|
| filled green circle | Connected; commands will run |
| amber ring | Connecting / reconnecting (it keeps trying by itself) |
| grey ring, struck through | Not connected (not set up, or stopped) |
| two violet bars | Commands paused |

Hover over it for the details. **Left-click** opens the window; **right-click**
opens the menu.

**Closing the window does not stop brobot** — it keeps running in the tray.
To stop it completely, right-click the tray icon → **Quit brobot**.

### Pausing

Going into a moment where a chat ban would ruin it? Right-click the tray icon →
**Pause commands**. brobot stays connected but says no to every ban until you
untick it (or click **Resume** in the window). The icon shows two bars while
paused.

To turn off just one of them for good, open the window and switch off
**Obey !chatban** or **Obey !voiceban**.

Stuck in a ban you need out of? Open the window and click **Release now**:
Enter works and the microphone is unmuted immediately.

### Test it

In the window, **Test chat ban** blocks Enter for 5 seconds and **Test voice
ban** mutes the microphone for 5 seconds — nothing is sent to chat. Try the
Enter key in Notepad during the test.

### If something is off

- **"brobot refused the secret"** — the secret is wrong or was changed. Paste
  the new one under Settings.
- **The microphone did not mute** — brobot mutes the microphone Windows has as
  the *default recording device* (Settings → System → Sound → Input). If OBS or
  Discord uses a different microphone, make that one the default.
- **Enter still works somewhere during a chat ban** — the block is a
  system-wide Windows keyboard hook; a program that reads the keyboard below
  that level could still see Enter. Tell the owner which program it was.
- The **Event log** in the window shows what brobot asked for and what this PC
  did about it, including any error.

---

## For developers

The app is `@singularity/brobot-client`, a workspace member of the singularity
monorepo. Architecture, the checks to run and the traps are in
[`CLAUDE.md`](CLAUDE.md); the wire contract with brobot is
[`shared/streamer-events.ts`](shared/streamer-events.ts).

```bash
pnpm --filter @singularity/brobot-client run dev     # renderer on :4206 + Electron, hot reload
pnpm --filter @singularity/brobot-client run build   # esbuild main/preload + ng build renderer
pnpm --filter @singularity/brobot-client run test    # vitest: renderer + shared + electron
```

To point a development run at a local brobot without saving anything:

```bash
BROBOT_SERVER_URL=ws://localhost:3000/api/ashketchum BROBOT_WS_SECRET=dev-secret \
  pnpm --filter @singularity/brobot-client run dev
```

(Ignored by the installed app.) Off Windows, host control is always the dry
run — the window says so.

### Building the installer

```bash
pnpm --filter @singularity/brobot-client run dist
```

Produces `release/brobot-setup-<version>.exe` (NSIS installer) and
`release/brobot-portable-<version>.exe`. **Run it on Windows.** electron-builder
can cross-build Windows targets from Linux only with Wine, and there is no
Windows CI runner, so **the installer is never built in CI**. What automation
does check is everything that can break on any OS: `pnpm run build` (esbuild
main/preload + `ng build`, part of the root `pnpm run build`), and lint, the
three typechecks and the unit tests, which the submodule pointer-bump gate
(`scripts/gate-bumped-submodule.sh`) runs before recording a new commit of this
repository. `pnpm run package` builds the unpacked app in `release/win-unpacked/`
for a quick look without the installer.

The installer is not code-signed, so SmartScreen warns on first run. Signing
needs a code-signing certificate and `win.signtoolOptions` (or Azure Trusted
Signing) in `electron-builder.json`.
