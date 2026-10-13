# Clawdle 0.1.0

A little word break while your coding agent works. Clawdle is a free, local five-letter word game for Windows: a daily puzzle, endless practice, and **Beat Claude**, which races a separate puzzle against a local Claude Code turn. No account, API key, telemetry, hosted database or model call.

## Install

Download `Clawdle_0.1.0_x64-setup.exe` (the standard installer) or the offline variant, which bundles WebView2. Compare `SHA256SUMS.txt` before installing. The installers are unsigned, so Windows may show a trust warning.

After installing, open **Settings → Claude connection settings** and install the local hooks for your user or a single project. Then restart your Claude Code session.

## What was verified

These checks ran on Windows 11 Home 10.0.26200 against packaged builds with real Claude Code 2.1.282 and a local synthetic model provider. No hosted model was used. The full record is in `docs/windows-smoke-checklist.md` and `docs/acceptance/`.

- Per-user install, launch and uninstall, including spaces and Unicode in paths. Existing unrelated Claude hooks and settings survive install, repeat install and removal.
- Daily and Endless offline, dictionary checks, and resume after a crash or restart.
- Race orderings: player first, Claude first, hidden window, short turn, two sessions, subagent Stop, provider error, crash recovery and a missed notification.
- The auto-shown race window never takes focus. Closing it hides it to the tray, and a hook launch never steals focus.
- The local receiver accepts only authenticated IPv4 loopback requests. It rejects a wrong token, Origin or Host, oversized bodies and slow clients.
- Private files carry owner-only ACLs and reparse points are refused.
- Exports and diagnostics contain no secrets, prompts or transcripts. The app makes no outbound traffic during ordinary play.
- Sleep and wake keep your puzzle. Export Save As and Cancel both behave normally. Tray Quit stops the app and its local listener.
- Keyboard navigation, a 320 px narrow layout, reduced motion and high contrast. Guesses get a Wordle-style flip reveal, which Reduced motion turns off.
- Memory: about 185 MiB private bytes, visible or hidden, within the 200 MB target. Hook delivery p95 is about 40-50 ms on a quiet machine.

## Known limitations

- **Clean machine:** offline installation on a PC without WebView2 has not been tested.
- **Monitor removal:** clamping the window when a monitor is unplugged has not been tested.
- **Claude Code versions:** verified with 2.1.282 and 2.1.287 on native Windows only. Interactive `SessionEnd` is unverified because headless Claude does not emit it, and it does not affect race results. WSL, SSH and remote providers are not verified.
- **Heavy CPU load:** the hook process can take longer than its 300 ms budget, and an occasional delivery can be dropped. The hook still exits silently, inside Claude's 1 s timeout, and the race then ends as interrupted rather than with an invented result.
- **Cold launch:** 3-7 s from launch to a playable puzzle on the test laptop, above the 2 s aim.
- **Tile contrast:** green and yellow tile text is below 3:1 in the Wordle palette. Turn on **High contrast** in Settings for symbols on every tile.
- **Uninstall:** a silent uninstall leaves the `HKCU\Software\clawdle\Clawdle` key. It is the standard Tauri installer behaviour and is harmless.
- **Accessibility:** the app follows its own Reduced motion and High contrast settings, not the Windows ones.
- Linux, macOS, other agents and an offline browser PWA are outside this release.
