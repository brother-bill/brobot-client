# brobot-client — app instructions

brobot's streamer desktop app: a Windows 11 tray app (Electron + Angular 21
zoneless on `libs/ngx-ui`) that stays connected to brobot's `/api/ashketchum`
socket and carries out `!chatban` (block Enter) and `!voiceban` (mute the mic)
on the streamer's machine. Charter and ticket map:
`guidelines/brobot/migration-plan.md` (this app is ticket C1). The streamer's
README is [`README.md`](README.md). Monorepo-wide rules live in
`guidelines/PROJECT.md`.

It is shaped like `apps/mediabot` on purpose — read that app's `CLAUDE.md` for
the Electron conventions this one inherits (sandboxed renderer, one typed
bridge, lazy Electron binary download).

## Verification checklist

From `apps/brobot-client/`:

```bash
pnpm exec eslint .
pnpm exec tsc --noEmit -p tsconfig.app.json       # renderer
pnpm exec tsc --noEmit -p tsconfig.electron.json  # main + preload + shared
pnpm exec tsc --noEmit -p tsconfig.spec.json      # specs — the other two do NOT cover them
pnpm run test                                     # vitest: renderer + shared + electron
pnpm run build                                    # esbuild main/preload, then ng build
```

`scripts/gate-bumped-submodule.sh` runs the same lint, typechecks and tests
before a pointer bump records a new commit of this repo. `electron-builder`
(`pnpm run dist`) is Windows-only and is never run in CI.

## Layout

| Path | What |
|---|---|
| `shared/streamer-events.ts` | brobot's wire contract, **copied byte for byte** from `apps/brobot/src/modules/twitch/streamer-events.ts`. Change both or neither. |
| `shared/server-events.ts` | The client's half: parsing what brobot sends, duration defaults and the 15-minute cap |
| `shared/bridge.ts` | The one IPC contract (operations + events), as in mediabot |
| `electron/main/core/` | Everything with logic, **free of Electron and Node imports**: the connection state machine, the command runner, the controller, tray-state mapping, the tray icon rasteriser. Tested in `*.spec.ts` beside each file |
| `electron/main/host/` | `HostControl`: the interface, the dry run, and the Windows driver (a PowerShell shim) |
| `electron/main/services/` | The Electron/Node edges: settings file + `safeStorage`, the `ws` socket |
| `electron/main/{main,tray}.ts`, `ipc/` | Wiring only |
| `renderer/` | The window: one page, four panels, a signals store |

## The things that will bite you

- **`core/` and `host/` must not import `electron` or `node:*`.** The unit
  tests run under the Angular unit-test builder, which bundles for the
  browser; a Node import there fails the whole suite. Anything that needs the
  OS is injected (`Clock`, `SocketFactory`, `ShimSpawner`, `SettingsStore`,
  `LoginItems`) and wired in `main.ts`.

- **nut.js cannot do a chatban.** It synthesises input; a chatban has to
  *suppress* it. The keyboard block is a `WH_KEYBOARD_LL` hook and the mic mute
  is Core Audio's `IAudioEndpointVolume`, both in C# compiled at run time by
  Windows PowerShell's `Add-Type` (`host/powershell-shim.ts` explains the
  choice). That compiler is **C# 5**: no `$"…"`, no `?.`, no `=>` members. A
  spec guards the obvious ones; `Add-Type` failing on a Windows machine is the
  only real test.

- **A ban must never outlive the app.** The hook dies with its PowerShell
  process; the mute shim restores on a `stop` line and when it sees the app's
  pid gone (start time compared, so a recycled pid does not count); and if it
  is killed anyway the main process runs the unmute shim with the device ids it
  reported. Keep all three if you touch it. stdin EOF is deliberately *not* a
  stop signal: a stdin that reads as closed from the start would end every ban
  at once.

- **Give every spawned shim's stdin an `error` listener** (`main.ts` does).
  `release()` writes `stop` to a process that may already have exited; an
  `EPIPE` on a stream with no listener is an uncaught exception in the main
  process.

- **Every ban from brobot gets exactly one `*_complete` reply** — declined ones
  too, with an `error`. brobot's vote counter waits for it; without it chat can
  never vote again until the client reconnects.

- **Close hides, Quit quits.** `window-all-closed` deliberately does nothing.
  A second launch focuses the first (single-instance lock).

- **Start-with-Windows is switched on once**, when setup first completes, and
  only in a packaged Windows build (`LoginItems.supported`); in development it
  would register `electron.exe`. The portable build registers
  `PORTABLE_EXECUTABLE_FILE`, not its temp-dir `execPath`.

- **`noPropertyAccessFromIndexSignature` is off** in this app's tsconfigs, only
  because the byte-for-byte contract copy uses dot access on a `Record`.
