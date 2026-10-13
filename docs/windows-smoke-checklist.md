# Packaged Windows acceptance record

Record OS version, app version, artifact checksum, Claude Code version, test
date, and outcome for every check. An unchecked item is unverified.

- [x] Standard per-user x64 install, launch, uninstall. *(acceptance/install.md)*
- [ ] Clean supported Windows PC offline install with no WebView2 present. *(Known limitation for v0.1.0: no clean machine available.)*
- [x] Disconnected Daily and Endless, dictionary lookup and close/reopen resume. *(acceptance/gameplay.md; resume fixed by #35)*
- [x] Real asynchronous silent hooks; malformed input and receiver-down exit budget. *(acceptance/install.md; fixed by #34. Tails can exceed 300 ms only under heavy CPU load.)*
- [x] Existing unrelated hooks/settings survive install, repeat install, remove. *(acceptance/install.md)*
- [x] Spaces and Unicode in installation/project paths. *(acceptance/install.md)*
- [x] Typing in an IDE continues without focus loss during automatic presentation. *(2026-10-13: maintainer typing while a real Claude turn auto-showed the window; the foreground app kept focus for all 924 samples. Earlier Notepad probe also passed.)*
- [x] Hook second launch never activates or steals focus. *(acceptance/gameplay.md)*
- [x] Tray close/reopen preserves puzzle; explicit Quit stops listener. *(Close/reopen: acceptance/gameplay.md and #37. Quit: maintainer, 2026-10-13; process exited and endpoint.json was removed.)*
- [ ] Geometry clamps to monitor work area after monitor removal. *(Known limitation for v0.1.0: no external monitor available.)*
- [x] Player-first, agent-first, hidden Stop, short turn, two sessions, child Stop. *(acceptance/gameplay.md, real Claude 2.1.282)*
- [x] Provider error, session end, sleep/resume, crash recovery, missed notification. *(acceptance/gameplay.md; sleep/resume kept the puzzle, maintainer 2026-10-13. Session end is unverified: headless Claude 2.1.282 does not emit it, and it does not affect races.)*
- [x] Permission attention never approves or operates Claude. *(Claude Code 2.1.282, 2026-10-12; see claude-compatibility.md.)*
- [x] Wrong token/Origin/Host/oversized/slow body rejected on IPv4 loopback only. *(acceptance/security.md; slow headers cut off by #34)*
- [x] Private endpoint/token/mailbox/settings-backup ACL and reparse-point checks. *(acceptance/security.md)*
- [x] Save failure never acknowledges a durable move or awards ranked progression. *(acceptance/security.md; SQLite write-lock fault only)*
- [x] Exports/diagnostics contain no secrets, prompt, transcript, response, or code. *(acceptance/security.md)*
- [x] No outbound application traffic during ordinary disconnected gameplay. *(acceptance/security.md; WebView2 browser-internal connections recorded separately)*
- [x] Keyboard navigation, narrow viewport, reduced motion, high contrast. *(acceptance/gameplay.md; Enter/focus fixed by #36. Tile colour contrast below 3:1 is a known limitation; High contrast mode exists.)*
- [x] Native plus WebView2 working set, idle CPU, warm/cold launch measured. *(native-performance.md: about 185 MiB private, within the 200 MB target; cold launch 3-7 s misses the 2 s aim.)*
- [x] Bridge running-receiver delivery p95 and hard 300 ms failure budget measured. *(acceptance/install.md)*

Publish only claims supported by this record. A build artifact alone does not
establish clean-machine installation or focus behavior.

## Executed on 2026-10-12

Windows 11 Home 10.0.26200. Standard and offline NSIS artifacts built. Offline artifact installed silently into an isolated repository directory with exit 0; dictionary, bridge, MIT license and dependency notices were present. The installed frontend wrote a valid playing Daily checkpoint. This host already had WebView2; the clean-machine gate remains unchecked.

All 28 native tests passed. The actual synthetic packaged hook/protocol benchmark passed with 39 persisted events and 34.43 ms p95 across 30 measured hook processes; see [native-smoke.md](native-smoke.md) for hashes and limits. These automated checks do not replace the unchecked OS interactions above.

Native UI helper failure: `foreground window did not report a process id`, reproduced with a refreshed window handle and normal application launch. Therefore installed GUI/focus/tray/Save As checks are not marked passed.

Later native UI revalidation displayed the actual light-theme game and native Export dialog successfully; the earlier helper failure did not reproduce. A valid native export file was created and retained privately. Reliable filename selection, cancellation, IDE focus, tray and physical sleep/resume checks remain unverified. Another foreground application interfered with dialog targeting, so this partial observation is not a completed GUI acceptance run.

The sustained performance attempt completed two 60-second idle intervals before a descendant-verification failure on the third launch. Partial measurements and limitations are recorded in [native-smoke.md](native-smoke.md); this failed invocation does not check off the complete performance gate.

## Executed on 2026-10-12 (evening): packaged GUI and memory

Windows 11 Home 10.0.26200. Built from main `1000849`: app SHA-256 `572CFC8FCF7C913B05A7B664B86F7BDE8ECB890509BEF3E09B5A6703CB99405F`, bridge SHA-256 `48E3DF5EB71FD24113D0C57E471D84D927672302F1BE09E39847785EF8C18E36`. Isolated test profiles under `.local/native-smoke-gui-*-1012b`. The real UI was driven through the WebView2 remote-debugging port (Playwright `connectOverCDP`). Window visibility and the foreground process were read with Win32 `IsWindowVisible` and `GetForegroundWindow`.

| Check | Result |
| --- | --- |
| Normal launch shows the window | Passed |
| Automatic races enabled, and project hooks installed, through the real Settings and Connection UI | Passed |
| Window close hides to tray; the process stays alive | Passed |
| Real Claude Code 2.1.282 turn while hidden (SessionStart, UserPromptSubmit, Stop) | Passed |
| Race auto-show makes the window visible | Passed |
| Auto-show never takes the foreground: Notepad stayed in front for all 1,268 samples at 25 ms over 40 s | Passed |
| A second launch reopens the existing instance | Passed |
| Letters typed into today's puzzle survive close and reopen | Passed |

Not covered by this run: explicit tray Quit, typing in an IDE, Save As selection and cancellation, physical sleep/resume, monitor removal.

Memory, same build, summed private bytes across 3 × 60 s launches (target: at most 200 MB visible or hidden):

| Presentation | Peak private | Mean private | Peak working set | Launch to first durable puzzle |
| --- | --- | --- | --- | --- |
| Visible | 184.8–188.2 MiB, **passes** | 179.2–183.5 MiB | 407–412 MiB | 3.3–6.8 s (cold-launch aim of 2 s not met; the readiness proxy includes harness inspection overhead) |
| Hidden (main `9585164` plus #27) | 182.9–187.6 MiB, **passes** | 180.8–184.2 MiB | 381–389 MiB | n/a |

## Maintainer manual checks, 2026-10-13

Windows 11 Home 10.0.26200, build of main `9ba2584`, isolated test profile.

| Check | Result |
| --- | --- |
| Sleep and wake with a Daily guess entered | Passed; the guess was still there |
| Export: Save As to a file, then a second export cancelled | Passed |
| Real Claude turn auto-shows the window while the maintainer types elsewhere | Passed; the window appeared, and focus stayed on the maintainer's app |
| Tray → Quit | Passed; the process exited and `endpoint.json` was removed |

The same session found and fixed: Enter reopening Settings after a dialog closed, a cramped Settings footer, the window opening partly behind the taskbar, and no Wordle-style reveal animation (#39).
