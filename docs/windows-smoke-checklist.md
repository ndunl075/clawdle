# Packaged Windows acceptance record

Record OS version, app version, artifact checksum, Claude Code version, test
date, and outcome for every check. An unchecked item is unverified.

- [ ] Standard per-user x64 install, launch, uninstall.
- [ ] Clean supported Windows PC offline install with no WebView2 present.
- [ ] Disconnected Daily and Endless, dictionary lookup and close/reopen resume.
- [ ] Real asynchronous silent hooks; malformed input and receiver-down exit budget.
- [ ] Existing unrelated hooks/settings survive install, repeat install, remove.
- [ ] Spaces and Unicode in installation/project paths.
- [ ] Typing in an IDE continues without focus loss during automatic presentation.
- [ ] Hook second launch never activates or steals focus.
- [ ] Tray close/reopen preserves puzzle; explicit Quit stops listener.
- [ ] Geometry clamps to monitor work area after monitor removal.
- [ ] Player-first, agent-first, hidden Stop, short turn, two sessions, child Stop.
- [ ] Provider error, session end, sleep/resume, crash recovery, missed notification.
- [ ] Permission attention never approves or operates Claude.
- [ ] Wrong token/Origin/Host/oversized/slow body rejected on IPv4 loopback only.
- [ ] Private endpoint/token/mailbox/settings-backup ACL and reparse-point checks.
- [ ] Save failure never acknowledges a durable move or awards ranked progression.
- [ ] Exports/diagnostics contain no secrets, prompt, transcript, response, or code.
- [ ] No outbound application traffic during ordinary disconnected gameplay.
- [ ] Keyboard navigation, narrow viewport, reduced motion, high contrast.
- [ ] Native plus WebView2 working set, idle CPU, warm/cold launch measured.
- [ ] Bridge running-receiver delivery p95 and hard 300 ms failure budget measured.

Publish only claims supported by this record. A build artifact alone does not
establish clean-machine installation or focus behavior.

## Executed on 2026-10-12

Windows 11 Home 10.0.26200. Standard and offline NSIS artifacts built. Offline artifact installed silently into an isolated repository directory with exit 0; dictionary, bridge, MIT license and dependency notices were present. The installed frontend wrote a valid playing Daily checkpoint. This host already had WebView2; the clean-machine gate remains unchecked.

All 28 native tests passed. The actual synthetic packaged hook/protocol benchmark passed with 39 persisted events and 34.43 ms p95 across 30 measured hook processes; see [native-smoke.md](native-smoke.md) for hashes and limits. These automated checks do not replace the unchecked OS interactions above.

Native UI helper failure: `foreground window did not report a process id`, reproduced with a refreshed window handle and normal application launch. Therefore installed GUI/focus/tray/Save As checks are not marked passed.

Later native UI revalidation displayed the actual light-theme game and native Export dialog successfully; the earlier helper failure did not reproduce. A valid native export file was created and retained privately. Reliable filename selection, cancellation, IDE focus, tray and physical sleep/resume checks remain unverified. Another foreground application interfered with dialog targeting, so this partial observation is not a completed GUI acceptance run.

The sustained performance attempt completed two 60-second idle intervals before a descendant-verification failure on the third launch. Partial measurements and limitations are recorded in [native-smoke.md](native-smoke.md); this failed invocation does not check off the complete performance gate.
