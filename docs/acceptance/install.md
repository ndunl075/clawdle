# Install and hook acceptance (Windows, packaged build)

Evidence for these items of [windows-smoke-checklist.md](../windows-smoke-checklist.md):
standard per-user install/launch/uninstall; unrelated hooks/settings surviving install, repeat install and remove;
spaces and Unicode in installation/project paths; real asynchronous silent hooks (malformed input, receiver down);
bridge running-receiver delivery p95 and the hard 300 ms failure budget. This file does not edit the checklist;
the maintainer decides what to tick.

## Re-run

```sh
node scripts/acceptance/install.mjs [--installer <Clawdle_0.1.0_x64-setup.exe>] [--tag <id>] [--samples 40]
```

Needs the built NSIS installer (default: `target/release/bundle/nsis/` in the main checkout), Node, Python 3,
Windows PowerShell 5.1 and a `pnpm install`ed checkout (the repo's `@playwright/test` is used only to attach to the hidden
WebView2 over CDP). It exits non-zero if any check fails and writes `.local/native-smoke-install-evidence-<tag>/result.json`
(every sample, every check, every state snapshot; not committed). Helpers: `scripts/acceptance/install-probe.ps1`
(registry/shortcut snapshot, window probe, .NET Stopwatch process timing, CPU load).

Safety properties of the script:

- Takes `.local/locks/machine.lock` in the main checkout (waits up to 15 min if held) and releases it in `finally`.
- Launches the app only as `clawdle-desktop.exe --hook-launch` (hidden, never focused); the script checks that no
  window of 100x100 px or more is visible (only 15x15 Tao/WebView2/IME helper windows are).
- All state is in fresh `.local/native-smoke-install-*` directories with `CLAWDLE_TEST_MODE=1` and
  `CLAWDLE_DATA_DIR` set; `WEBVIEW2_USER_DATA_FOLDER` is inside that profile. The real Clawdle profile is not
  used (it verifies `%LOCALAPPDATA%\org.clawdle.desktop` gained no files), `~/.claude/settings.json` is only
  stat-ed (mtime+size unchanged), and hook install/uninstall runs only with `--scope project` on fixture projects.
- Never calls a model and never runs Claude.
- The NSIS installer can only write per-user state in real locations (HKCU registry, Start menu, Desktop); see
  item 1 for exactly what and that uninstall removes it. The script refuses to run if any such state already exists.

## Environment (final run, tag `t5`, 2026-10-12 22:55 EDT = 2026-10-13T02:55Z)

| | |
| --- | --- |
| OS | Windows 11 Home 10.0.26200 build 26200.9457, x64 |
| Source | `main` at `1000849` (PR #29 merged); installer built from it by the maintainer session |
| Installer | `Clawdle_0.1.0_x64-setup.exe`, 2,672,975 B, SHA-256 `7201d28755ad74f0ac65e8309b22240653c75d7af686df4bf2c90e9f84622c58` |
| Installed `clawdle-desktop.exe` | 6,164,480 B, SHA-256 `6dfe091ae1b43651b97c064fd048392853b74776c2adb198068f04ee1ef298a6` |
| Installed `clawdle-bridge.exe` | 491,520 B, SHA-256 `48e3df5eb71fd24113d0c57e471d84d927672302f1be09e39847785ef8c18e36` (identical to `target/release/clawdle-bridge.exe`) |
| `target/release/clawdle-desktop.exe` | SHA-256 `572cfc8fcf7c913b05a7b664b86f7bde8ecb890509bef3e09b5a6703cb99405f`; same size as the installed copy, 3 bytes differ (offsets 5661344..5661346, a PE-header-sized region, i.e. a relink); the installed copy is the shipped artifact |
| Tools | Node v22.21.0, Windows PowerShell 5.1, Python 3.13 |
| WebView2 | already present on this host (not a clean-machine test) |

Result of the final run: **124 checks, 118 passed, 6 failed**. (A confirmation run `t6` after lint-only edits to the
script: 117/124; the extra failure is the load-sensitive p95 below, the other six are the budget findings.) All six failures are the same product finding
(hard 300 ms budget exceeded when delivery fails; see "Product finding"). Earlier invocations (tags `t1`..`t4`) were used to
debug the harness (order-sensitive JSON comparison, console encoding, a window-visibility rule that counted 15x15 helper
windows) and to see run-to-run variance; the budget failures were identical in every one of them, and the only variable
result was running-receiver latency under CPU load (item 5).

## Results

| # | Item | Result |
| --- | --- | --- |
| 1 | Per-user x64 install, launch, uninstall | **PASS** |
| 2 | Unrelated hooks/settings survive install, repeat install, remove | **PASS** (3 cosmetic observations) |
| 3 | Spaces and Unicode in installation and project paths | **PASS** |
| 4 | Asynchronous silent hooks: malformed stdin | **PASS** |
| 4 | Receiver down exits within 300 ms | **FAIL**: 308.8-342.3 ms (30 runs) when `endpoint.json` is stale |
| 5 | Running-receiver delivery p95 < 50 ms goal | **PASS** in the final run: pooled p95 46.8 ms (120 warmed runs); **load-sensitive** |
| 5 | Hard 300 ms failure budget | **FAIL**: see Product finding |
| 6 | `Stop`/`StopFailure` synchronous (PR #29) | **PASS** in the real installed settings |

### 1. Install, launch, uninstall (isolated dir, `/S /D=<path>`)

Two cycles: `.local\native-smoke-install-t5\install dir` and `.local\native-smoke-install-ünï cödé dir t5\install dir`.

- Silent install exit 0 (1.6 s plain, 2.8 s Unicode). Installed files: `clawdle-desktop.exe`, `clawdle-bridge.exe`,
  `uninstall.exe`, `words\`, `licenses\`, `LICENSE`, `THIRD_PARTY_NOTICES.md`.
- Launch: installed exe with `--hook-launch` published `endpoint.json` in 654 ms (plain) / 871 ms (Unicode), the receiver
  PID equals the launched process, the main window "Clawdle" (435x687) and the tray window exist but are hidden,
  no user-visible window, CDP rendered the 30-tile grid, and SQLite holds one `daily` game with status `playing`.
  No file was created in the real `%LOCALAPPDATA%\org.clawdle.desktop` (empty before, empty after); no Run-key was written.
- Silent uninstall (`uninstall.exe /S`) finished in 3.8 s (plain) / 3.5 s (Unicode); the directory itself is removed.

Exactly what the installer writes outside the install directory (all HKCU or the user profile, no HKLM, no admin):

| Where | Content | Removed by silent uninstall? |
| --- | --- | --- |
| `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\Clawdle` | `DisplayName=Clawdle`, `DisplayVersion=0.1.0`, `Publisher=clawdle`, `InstallLocation`, `UninstallString`, `DisplayIcon`, `MainBinaryName`, `NoModify=1`, `NoRepair=1`, `EstimatedSize=15063` | yes |
| `HKCU\Software\clawdle\Clawdle` | `(Default)` = install directory | **no** (see below) |
| `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Clawdle.lnk` | targets the installed exe | yes |
| `%USERPROFILE%\Desktop\Clawdle.lnk` (created for silent installs) | targets the installed exe | yes |

Nothing else: no Run/autostart entry, no `%LOCALAPPDATA%\Clawdle`, no `%APPDATA%\org.clawdle.desktop`.

Observation: a silent uninstall leaves `HKCU\Software\clawdle\Clawdle` (install directory string) behind. This is the stock
Tauri NSIS template, which removes that key only when the GUI uninstaller's "Delete app data" box is ticked
(`installer.nsi` lines 1694-1703); it is also what lets a reinstall default to the previous directory. The harness deleted
that key itself after recording it, because it pointed at a harness directory; the Delete-app-data path was not run, as it
would also remove the real `%LOCALAPPDATA%\org.clawdle.desktop`.

### 2. Existing hooks/settings survive (project scope, bridge CLI from the installed dir)

Fixture `settings.local.json` with `model`, `env` (with Unicode), `permissions`, `statusLine`, and pre-existing hooks on
`Stop`, `PostToolUse` (matcher + async), `SessionStart` (matcher), `UserPromptSubmit` (two handlers) plus an unrelated event
`PreCompact`. All of the following passed in both the plain and Unicode cycles:

- Install exit 0; every unrelated key and hook unchanged (compared as parsed JSON); ten owned handlers, exactly one per
  event; the user's group on each shared event is kept first and ours appended after it.
- Handler command is the installed bridge's absolute path; `timeout: 1`; `async: true` except `Stop`/`StopFailure`.
- Repeat install: no duplicates, file byte-identical to the first install.
- User edits made between install and uninstall (extra `permissions.allow`, an extra `Stop` group, a new `Notification`
  group) are all kept by uninstall; only owned handlers are removed; a second uninstall is a no-op.
- A pristine install+uninstall round trip restores the original parsed settings.
- Plain cycle only: a file with no `hooks` key, a missing file, invalid JSON (exit 1,
  `settings_invalid_json_use_manual_setup`, file byte-identical) and `hooks` of the wrong shape (exit 1,
  `unsupported_hooks_shape`, file byte-identical).

Observations (not failures, unrelated content is intact):

- Install rewrites the whole file with alphabetically sorted keys (original order `model,env,permissions,statusLine,hooks`
  becomes `env,hooks,model,permissions,statusLine`) and 2-space indentation.
- Uninstall leaves empty event arrays (`"PermissionRequest": [], "PreToolUse": [], "SessionEnd": [], "StopFailure": [],
  "SubagentStop": []`) for events that had no user hooks.
- The ownership manifest and background-launch preference are written to `CLAWDLE_DATA_DIR`, not the real profile.

### 3. Spaces and Unicode

The Unicode cycle runs everything with installation path `...\native-smoke-install-ünï cödé dir t5\install dir\`, profile,
projects and WebView2 data folder in the same space-and-Unicode tree, and project `proj-same-events` etc. under it. Passed:
silent install/uninstall, shortcut targets, registry `InstallLocation`, `--hook-launch` start and puzzle persistence, hook
install/repeat/uninstall (item 2 checks), and the installed `SessionStart` and `Stop` handlers executed from their
settings `command` + `args` (not from a hand-built command line) delivered to the receiver. The key reads
`(Default)=...ünï cödé dir t5\install dir` and shortcuts resolve to it.

### 4. Silent hooks

Every run: exit code 0, 0 bytes on stdout, 0 bytes on stderr. Timing is a .NET `Stopwatch` around
`Process.Start`..`WaitForExit`, including the stdin write (the method `native-smoke.ps1` uses); 1 warmup, 3 runs each.

| stdin | max ms, receiver up | max ms, receiver down |
| --- | ---: | ---: |
| empty | 25.1 | 50.6 |
| not JSON | 30.1 | 24.4 |
| truncated JSON | 46.5 | 28.7 |
| JSON array | 31.7 | 27.6 |
| missing `session_id` | 28.5 | 33.9 |
| wrong field types | 44.9 | 55.1 |
| unknown event name | 32.1 | 28.8 |
| invalid UTF-8 | 29.1 | 27.6 |
| NUL bytes | 28.3 | 26.6 |
| 100,000-deep nested `[` | 27.8 | 54.3 |
| > 4 MiB | 32.9 | 29.9 |
| stdin held open, never closed | **315.2** | **322.5** |

Malformed input added no journal event with the receiver up. Receiver down (no `endpoint.json`, which is what a graceful quit
leaves): 30 runs, min 24.4, median 27.0, p95 54.2, max 57.5 ms, no mailbox and no process launched (auto-launch is off by
default). Receiver down with a **stale** `endpoint.json` (app force-killed): see the finding below.

### 5. Running-receiver delivery

Installed bridge, hidden installed app, SessionStart payload, 5 warmups then 3 rounds x 40 runs (120), harness CPU busy
14%/18%/32% before the rounds:

| | n | min | median | p95 | max |
| --- | ---: | ---: | ---: | ---: | ---: |
| wall ms (Stopwatch) | 120 | 23.6 | 30.0 | **46.8** | 70.1 |
| process lifetime ms (ExitTime-StartTime) | 120 | 21.4 | 27.6 | 41.0 | 63.7 |
| per-round wall p95 | | | | 47.0 / 46.5 / 34.4 | |

All 135 sent events (incl. warmups) are in the journal: 0 silent loss. Unicode cycle: 10 runs, p95 61.9 ms (CPU 49% busy).
Max 70.1 ms is far inside the 300 ms budget. **Load sensitivity:** earlier invocations of this script on the same machine
gave a first-round p95 of 39.4 ms (quiet), then 177 ms, 101.9 ms pooled and (the post-lint confirmation run `t6`, 75% CPU busy
before two of three rounds) 77.1 ms pooled, max 190.2 ms, when other sessions and the user's work were using the CPU; in the 177 ms run one handler delivery hit the 280 ms deadline and was not journaled (the script retries
that single probe and reports the attempt count). A single p95 number from this laptop is therefore a measurement of its
load as much as of the bridge.

### 6. Terminal hooks

In the real installed settings (both cycles) `Stop` and `StopFailure` have `timeout: 1` and no `async`; the other eight
events have `async: true`. The installed `Stop` handler, run from those settings, delivered.

## Product finding: the 300 ms hard budget is exceeded whenever delivery fails (not fixed here)

`ARCHITECTURE.md` section 10 requires "a total hook execution budget of 300 ms, including stdin read and failed local
requests" and the checklist asks for a hard 300 ms failure budget. The bridge enforces an internal 280 ms deadline
(`crates/local-bridge/src/main.rs:13-14`: `HOOK_DEADLINE_MS = 280`, `HOOK_ATTEMPT_MS = 140`, two attempts), which leaves about
20 ms for process start and teardown; the measured overhead is about 25-30 ms, so every failure path that consumes the whole
deadline ends outside 300 ms. Wall-clock numbers, final run (Stopwatch, spawn to exit):

| Scenario | n | min | median | p95 | max |
| --- | ---: | ---: | ---: | ---: | ---: |
| Receiver crashed/killed, stale `endpoint.json` (plain install) | 30 | 308.8 | 312.8 | 329.8 | **342.3** |
| same, kernel lifetime (ExitTime-StartTime) | 30 | 306.3 | 310.3 | 324.6 | 327.1 |
| same, Unicode install | 10 | 310.9 | 312.6 | 339.4 | 339.4 |
| Receiver accepts but never answers (loopback listener) | 15 | 308.1 | 311.8 | 385.9 | **385.9** |
| stdin held open, never closed (up / down) | 3 | | | | 315.2 / 322.5 (Unicode up: 349.8) |

Earlier runs of the same script saw maxima of 419 ms and 444.7 ms for the stale-endpoint case. The minimum is already above
300 ms, so this is systematic, not noise. Without an `endpoint.json` (graceful quit removes it, `receiver.rs:114`) the
hook exits in about 27 ms median, so the over-budget case is a crashed or force-killed app, a hung receiver, or a caller
that never closes stdin.

Likely cause (inference from the timings, not separately proven): on Windows a loopback `connect()` to a port with no
listener does not fail fast; `TcpStream::connect_timeout` consumes its whole 140 ms attempt budget twice (min 308 ms), then
the 280 ms watchdog returns.

Impact: asynchronous hooks cost Claude nothing. `Stop`/`StopFailure` are now synchronous, so after a receiver crash each
costs about 0.31-0.39 s of Claude's wall time per terminal hook; this is still inside the installed 1 s `timeout`, and silent
(exit 0, no output). The doc requirement is the only thing violated.

Repro (hidden, test profile):

1. Install silently to an isolated directory, or use any built `clawdle-bridge.exe`/`clawdle-desktop.exe` pair.
2. With `CLAWDLE_TEST_MODE=1` and `CLAWDLE_DATA_DIR=<fresh dir>`, start `clawdle-desktop.exe --hook-launch`, wait for
   `endpoint.json`, then `taskkill /PID <pid> /T /F` so the file stays.
3. Time 30 runs of `clawdle-bridge.exe hook --provider claude` with stdin `{"hook_event_name":"SessionStart","session_id":"x"}`
   (same env). Expect <= 300 ms; observed 309-342 ms, never below 306 ms.

Or simply run `node scripts/acceptance/install.mjs`; the `receiver-down` and `malformed ... stdin held open` checks fail.

A fix is product code and is left to the architect (for example a deadline near 240-250 ms and/or failing fast when the
connection is refused); the checks above will then pass without change.

## Not covered (still unverified)

- Clean machine with no WebView2 and the offline installer: not run (this host has WebView2).
- Interactive/GUI NSIS flow, "Delete app data" uninstall, upgrade over an existing install, uninstall while the app runs.
- Graceful Quit removing `endpoint.json` was read from source (`receiver.rs:114`), not exercised through the tray.
- Real Claude Code delivering to the installed hooks (done separately by `scripts/claude-lifecycle-smoke.py`).
- Global (`--scope user`) install: never run, by design, as it would edit the real `~/.claude`.
