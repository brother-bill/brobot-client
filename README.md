# brobot for Windows

brobot's app for the streamer's PC. It sits in the system tray, stays
connected to brobot, and when chat votes for it, it does the thing to this
computer:

- **!chatban** — blocks your **Enter** key for 5 minutes, so you cannot send
  chat messages.
- **!voiceban** — **mutes your microphone** for 30 seconds, and presses **F8**
  as it starts and **F9** as it ends so Streamlabs shows and hides the
  voiceban overlay (see [Key bindings](#key-bindings)).

When the time is up it puts everything back and tells brobot, and chat can
vote again.

It also gives you three shortcuts that work from any app or game:
**Ctrl+Alt+F5** puts a stream marker on the VOD, **Ctrl+Alt+F4** starts the
prediction and **Ctrl+Alt+F7** runs an ad break.

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

Under it, **Overlay** says whether brobot can see your stream overlay — the
browser source in Streamlabs/OBS where Pokémon roars and quacks play. brobot
refunds every roar and quack while it sees none, so **Overlay: not connected**
is worth fixing before you go live: the window shows the URL to put in the
browser source (`https://brobot.live/twitch/supahot/overlay`) and reminds you
to turn off **Shutdown source when not visible** in its properties, or the
overlay drops out whenever its scene is not showing. **Overlay: unknown** means
brobot has not said yet (not connected, or a brobot from before it could).

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

### Key bindings

Every key brobot listens for or presses is under **Settings → Key bindings**
in the window. Each one shows its keys, with **Change**, **Test**,
**Reset to …** (when it is not the default) and **Off**.

**Shortcuts you press** — they work from any app, in a game too:

| Shortcut | Default | Does |
|---|---|---|
| Marker | **Ctrl+Alt+F5** | Puts a stream marker on the Twitch VOD |
| Prediction | **Ctrl+Alt+F4** | Starts the channel prediction |
| Ad | **Ctrl+Alt+F7** | Runs a 30 s ad break |

brobot does it on Twitch and answers: the event log says "Stream marker
created" (or why not, such as "No ad break: not live") and Windows shows the
same as a notification. Pressing one again within 5 seconds is ignored. If
brobot is not connected, or **Safe mode** is on, nothing is sent and the
notification says so.

If another app already uses a combination, Windows will not give it to brobot:
the line under it turns into **"Not working: another app already uses …"**, the
event log says so and Windows shows a notification. Pick another combination
(or free it in that app).

**Keys brobot presses for Streamlabs/OBS** — when a voiceban starts brobot
presses **Voiceban start** (**F8**), and when it ends — time up,
**Release now**, or brobot quitting — it presses **Voiceban end** (**F9**).
It presses them like a real keyboard would, so any app with a global hotkey on
them sees it.

**Streamlabs (or OBS) must have those keys bound** for the overlay to change:
in Streamlabs, **Settings → Hotkeys** (in OBS, **Settings → Hotkeys**), bind
the Voiceban start key to whatever shows the voiceban overlay (and mutes there,
if you want) and the Voiceban end key to whatever hides it. brobot mutes the
Windows microphone itself either way. A reminder of which key each one must be
is always shown under them.

To change a binding, click **Change** and press the new combination (hold
Ctrl, Alt or Shift and press the key); **Esc** cancels. brobot refuses:

- a combination another binding already uses (two on one key would set each
  other off) — except that Voiceban start and Voiceban end may be the same key,
  for a Streamlabs hotkey that toggles the overlay,
- a plain letter, number, arrow or Space without Ctrl or Alt (it would go off
  while you type or play) — F keys are fine on their own,
- anything with **Enter** (that is the key a chat ban blocks) and Alt+F4.

It warns, and asks before saving, when a shortcut is one other streaming
software uses out of the box (Discord's Ctrl+Shift+M, NVIDIA's Alt+F9, …), or
when Windows says another app already has it. Changing a voiceban key (or
turning it off) always asks first: **Streamlabs/OBS must have the new key
bound to the overlay** — update the hotkey there too, or the overlay stops
switching.

**Test** next to a shortcut sends it to brobot for real (an ad test runs a real
ad). **Test** next to a voiceban key presses it once, so you can watch the
overlay switch in Streamlabs. In **Safe mode** both only write what they
would have done in the event log ("Would press F8 (overlay on)").

Stuck in a ban you need out of? Open the window and click **Release now**:
Enter works and the microphone is unmuted immediately.

### Test it

In the window, **Test chat ban** blocks Enter for 5 seconds and **Test voice
ban** mutes the microphone for 5 seconds — nothing is sent to chat. Try the
Enter key in Notepad during the test. The voice ban test presses the overlay
keys for real too (unless Safe mode is on), so it is also how to check the
Streamlabs hotkeys. Each key binding has its own **Test** too (see
[Key bindings](#key-bindings)).

### Updates

brobot looks for a new version by itself, a minute after it starts and then
every four hours. When there is one, Windows shows a notification, the tray
menu gets an **Install brobot <version>** line, and the window shows what
changed with **Install now** and **Later**.

Nothing downloads or installs until you click **Install now** (in the window
or the tray). brobot then downloads it, closes, installs it and opens again by
itself, still set up and connected. Any ban in progress ends first. **Later**
hides it in the window until the next version; the tray line stays. You can
also look by hand: **Check for updates** in Settings.

The portable exe cannot update itself: download the new one from the
[releases page](https://github.com/brother-bill/brobot-client/releases/latest).

### If something is off

- **"brobot refused the secret"** — the secret is wrong or was changed. Paste
  the new one under Settings.
- **The microphone did not mute** — brobot mutes the microphone Windows has as
  the *default recording device* (Settings → System → Sound → Input). If OBS or
  Discord uses a different microphone, make that one the default.
- **A shortcut does nothing** — look under Settings → Key bindings. "Not
  working: another app already uses …" means Windows gave that combination to
  another app: change it. Otherwise the event log says what happened to the
  press (not connected, safe mode, or brobot's answer).
- **The Streamlabs overlay did not change** — check the event log says
  "Pressed F8 (overlay on)", then check Streamlabs has that key bound under
  Settings → Hotkeys. If Streamlabs runs as administrator, Windows may keep
  key presses from a normal app away from it: run both the same way.
- **"Overlay: not connected"** — Streamlabs/OBS is not showing brobot's
  overlay, so roars and quacks are refunded. Check the browser source's URL is
  the one the window shows, that **Shutdown source when not visible** is off,
  and that the source is in the scene you stream.
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
pnpm --filter @singularity/brobot-client run dist:linux   # on x86_64 Linux or WSL
pnpm --filter @singularity/brobot-client run dist         # on Windows
```

Either one produces `release/brobot-setup-<version>.exe` (NSIS installer) and
`release/brobot-portable-<version>.exe`. **The usual way is neither:** dispatch
singularity's **Build brobot-client installer** workflow
(`gh workflow run build-brobot-client.yml --ref main`, staged in
[`deploy/github/build-brobot-client.yml`](../../deploy/github/build-brobot-client.yml)
until the owner copies it in). It runs `dist:linux` on the self-hosted CI
runner and attaches both exes to the run for 7 days. It builds the
brobot-client commit singularity records, so merge a change and let the
pointer bump land before you dispatch.

`dist:linux` ([`scripts/dist-linux.sh`](scripts/dist-linux.sh)) needs no root
and no container. electron-builder runs the NSIS installer once to write its
uninstaller, and that needs Wine, so the script downloads a pinned,
checksummed, relocatable Wine into `~/.cache/brobot-client` on first use
(~100 MB download, ~1.4 GB on disk with its prefix). The script's header
explains why that particular build.

What runs on every change is everything that can break on any OS:
`pnpm run build` (esbuild main/preload + `ng build`, part of the root
`pnpm run build`), and lint, the three typechecks and the unit tests, which the
submodule pointer-bump gate (`scripts/gate-bumped-submodule.sh`) runs before
recording a new commit of this repository. Nothing compiles the PowerShell
shim's C# except Windows itself, so install a new build on a Windows PC before
handing it over. `pnpm run package` builds the unpacked app in
`release/win-unpacked/` for a quick look without the installer.

### Releasing an update

Installed copies (1.1.0 and later) update from GitHub Releases on
[brother-bill/brobot-client](https://github.com/brother-bill/brobot-client/releases).
To ship one:

1. Bump `"version"` in `package.json` (a release of the same version is
   refused) and merge.
2. Build it: `gh workflow run build-brobot-client.yml --ref main` in
   singularity, and wait for it to finish.
3. Publish it, with the notes the streamer will read:

   ```bash
   apps/brobot-client/scripts/publish-release.sh <run-id> "Fixes the mic not unmuting after a voice ban."
   ```

   The run's summary prints this line with its id filled in. The script uses
   your own `gh` login, checks the installer against `brobot-update.json`, and
   creates release `v<version>` with the installer, the portable exe and the
   manifest.

Each copy picks it up within four hours or at its next start. The app reads
`brobot-update.json` (written at build time by `scripts/release-manifest.mjs`)
and refuses an installer whose size or SHA-512 does not match, or one hosted
anywhere but this repository's releases. The update runs the NSIS installer
silently (`/S --updated --force-run`): it installs to the folder chosen the
first time and starts the new version. Settings in `%APPDATA%\brobot` are not
touched.

The installer is not code-signed, so SmartScreen warns on first run. Signing
needs a code-signing certificate and `win.signtoolOptions` (or Azure Trusted
Signing) in `electron-builder.json`.
