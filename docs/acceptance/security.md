# Security acceptance: packaged release app

Re-run with one command (needs the main checkout's `target/release` binaries and Claude Code installed):

```sh
node scripts/acceptance/security.mjs [--tag NAME] [--only receiver,acl,reparse,privacy,traffic,savefail]
```

The script takes `.local/locks/machine.lock` in the main checkout (waits if held), launches the release app **hidden** (`--hook-launch`, never visible) against fresh `.local/native-smoke-sec-<tag>-*` profiles with `CLAWDLE_TEST_MODE=1`, drives it over WebView2 CDP on port 9342, and writes `.local/native-smoke-sec-<tag>-results.json`. All evidence below comes from that file. Claude Code runs only through `scripts/claude-lifecycle-smoke.py` against its synthetic loopback provider. `~/.claude/settings.json` was hashed before and after and was unchanged. Helpers: `security.win.ps1` (ACL and socket probes), `security.db.py` (read-only SQLite snapshot, write-lock fault injector, smoke wrapper).

## Run recorded here

| | |
| --- | --- |
| Date | 2026-10-12 (evening, local), tag `t6`: 75 pass, 0 fail, 8 info |
| OS | Windows 11 Home 10.0.26200 |
| Source | `main` at `869df45` (includes the PR #34 receiver header-timeout fix); `target/release` binaries built from the fix at 23:19-23:20 local |
| `clawdle-desktop.exe` 0.1.0 (release build, not the NSIS installer) | sha256 `838db3163408b2c9b3ad1c6af42fdcd6837b401bfbf66fa85ecf0c8bead52525` |
| `clawdle-bridge.exe` | sha256 `c19a496554c7b9bd4c79622508adbe8014e263353142837d58072deed558300b` |
| Claude Code | 2.1.282, synthetic provider only |
| Node / Python | v22.21.0 / 3.13.14 |

Two earlier runs (`t1`, `t2`) failed on harness defects, not product defects, and were fixed before `t3`. `t3` (binaries from `1000849`, hashes `572cfc8f...` / `48e3df5e...`) found the unbounded header slow-loris described below; after PR #34, `t4` aborted because another session's app was running (the script now waits for it under the lock), `t5` passed with the slow-loris still informational, and `t6` made it a gated check. In `t1` the smoke script ran from a worktree whose `.local` it does not own. In `t2` the ACL check demanded "protected" on a child directory that inherits an owner-only ACL, a substring check mistook "could not be saved" for "saved", the traffic gate lumped WebView2 in with the app, and the cleanup did not remove a planted file symlink (removed by hand, link only).

## Results

### 1. Receiver rejections and interface binding: PASS

All against the live app's receiver (OS-assigned port on 127.0.0.1). Timings are first byte on loopback.

| Probe | Result |
| --- | --- |
| Control: `GET /v1/health`, correct token and Host | 200 in 2-3 ms; body is protocol version and runtime epoch only, no token |
| Control: correct auth, body `{}` | 400 (auth passed, validation rejected) |
| No Authorization, wrong token, truncated token | 401, 1 ms |
| `Origin: http://evil.example`, `Origin: null` | 401, 1 ms |
| Host `127.0.0.1:1`, `localhost:<port>`, `evil.example:<port>` | 401, 1-2 ms |
| Token in query string | 401 |
| Wrong Content-Type, malformed JSON | 415, 400 |
| 9000 B body (cap is 8 KiB) | 413, 1 ms |
| 1 MiB body | connection reset after 5 ms (no status read) |
| Slow body: header says 2000 B, 10 B sent, then stall | 413 after 107 ms (server bound is 100 ms) |
| Slow-loris on headers (header block never finished, one line per 500 ms) | connection reset after 515 ms (gated: must end within 3 s); in `t3`, before the fix, it stayed open for the whole 14 s window |
| 150 concurrent authenticated posts | 100 x 400, 50 x 429 |
| Journal rows created by any rejected request | 0 (agent rows 0 before and after) |

Listening: `Get-NetTCPConnection` for the app's process tree shows the receiver port only on `127.0.0.1`; no `0.0.0.0`, `::` or `::1` listener on it. The only other listener is the harness CDP port 9342 on 127.0.0.1. Direct connects: `127.0.0.1` connects (control); `::1` and `127.0.0.2` are refused in 2 ms; the machine's LAN IPv4 address is refused (a RST after about 2 s, not a connection).

Not covered: IPv6 LAN addresses (the machine had no non-link-local ones) and Windows Firewall behavior.

### 2. Private files and reparse points: PASS

ACLs (`Get-Acl` plus `icacls`): every item below has owner = current user and an explicit `OWNER RIGHTS:(F)` ACE as its only entry, and no inherited broad grants. There is no ACE for Everyone, Users, Authenticated Users or Administrators. A control file deliberately granted to Everyone is flagged by the same checker. `OWNER RIGHTS` is read as "the current user"; SYSTEM has no ACE of its own.

Checked: `token`, `endpoint.json` and the data directory (app-created, live); the data directory, hook-created `token`, `ownership/` and its manifest, a mailbox entry, and a settings backup (`settings.local.clawdle-backup-*.json`) from a real `clawdle-bridge install` plus a cold-start hook. The `mailbox/` directory has no explicit ACL of its own: it is not marked protected but inherits the single owner-only ACE from the protected data directory.

Reparse points were planted in fixture directories only: junctions via `mklink /J`, and a file symlink (this machine permits symlink creation). In every case nothing was written through the link and the target stayed empty.

| Planted link | Result |
| --- | --- |
| `ownership` junction in the data dir, then `bridge install` | exit 1 `private_directory`; target empty, target ACL unchanged, project settings unchanged |
| `token` junction, then hook | hook exits 0 in 40 ms; nothing written, no endpoint |
| `mailbox` junction with cold start enabled | hook exits 0 in 47 ms; nothing written |
| project `.claude` junction, then install | exit 1 `unsafe_settings_path`; target empty |
| `token` as a file symlink | refused; target file unchanged |
| app started with a `mailbox` junction inside its data dir | no `endpoint.json`, no listener, process exited |
| app started with the data dir itself a junction | process exited, nothing written to the target |

All 7 links were removed (link only) and every target still existed.

Notes: the app refusing to start, rather than degrading, is the observed behavior. `atomic_write` also gives a real `settings.local.json` a protected owner-only ACL when hooks are installed (seen on the fixture project); not asserted as a defect.

### 3. Exports and diagnostics contain no secrets: PASS (with a stated limit)

A real Claude Code 2.1.282 turn ran against the synthetic provider while the app ran. `SessionStart`, `UserPromptSubmit` and `Stop` were journaled and the provider saw only `/v1/messages`. The canary prompt (`SYNTHETIC_PRIVATE_PROMPT_<hex>`), session id and token came from the run itself, and the canary was confirmed present in Claude's own fixture transcript, so the needle is the real prompt.

- **Export:** the Export button passes `controller.exportData()` to `native_export`, which opens the native Save dialog; that cannot be driven on a hidden window. The script instead calls **the same `controller.exportData()` through the live page's React tree**. This exercises the real export payload (2509 bytes, 2 games, 1 race) but **not** the Save dialog or the file write. The payload has the `clawdle-export` v1 shape that `native_export` validates, and contains none of: token, canary, canary prefix, session id, home path, or any `sessionId`, `turnId`, `token`, `prompt`, `transcript`, `response`, `command` or `endpoint` key.
- **Doctor:** read from the real UI (Settings, Claude connection settings, Check connection) and from `clawdle-bridge doctor`. Both report `tokenPresent: true` and contain none of the five needles.
- **Disk:** after the app exited, 172 files / 10.8 MB of the data dir (SQLite, WAL, config, endpoint, WebView2 profile) were scanned. No canary and no canary prefix; the token appears only in `token`. The session id appears only in `clawdle.sqlite-wal` (a sanitized local correlation id, by design). The home-path string appears only inside the WebView2 profile folder.

### 4. No outbound application traffic in ordinary gameplay: PASS for the application; WebView2 observation recorded

60 s of Daily then Endless play via CDP (12 guess attempts, 17 journal commands). Sockets of the app and its WebView2 descendants were sampled every 400 ms (30 samples, 7 processes) with `Get-NetTCPConnection` and `Get-NetUDPEndpoint`; the page's own requests were recorded through CDP.

- `clawdle-desktop.exe`: one TCP flow, loopback only. **No non-loopback peer.**
- Page requests: only `ipc.localhost`; no websockets, no foreign host.
- **WebView2 browser-internal, recorded separately and not gated:** the WebView2 browser process held one established TCP connection to a Microsoft-range address (52.96.x.x:443) in 30 of 30 samples, from the first sample. Its network-service process briefly connected to 150.171.28.11:443 (4 of 30 samples) and has a UDP socket bound on `0.0.0.0`. Purpose and trigger were not determined. Sampling cannot see packets, short flows between samples, or DNS. This is Edge/WebView2 behavior rather than Clawdle code, but the checklist line "no outbound traffic" is demonstrated for the application process and **not** for the whole process tree. Mitigation (WebView2 browser arguments, firewall test) is a product decision and was not attempted.

### 5. Save failure never acknowledges a move or awards progression: PASS (one fault type)

Fault: a second SQLite connection held `BEGIN IMMEDIATE` (the write lock) on the profile database for the whole fault window. Disk full, read-only volume and I/O errors were **not** injected.

- Control (healthy storage): a guess is journaled (commands 1 to 2) and shown.
- Locked, non-winning guess: journal commands unchanged (2 to 2), the game still has 1 saved guess, the UI shows 1 scored row and "Your move could not be saved. Please try again." (after SQLite's busy wait, about 9 s).
- Locked, **winning** guess (answer read from the profile's `wordId`): journal unchanged, results 0 to 0, game status `playing`, no result panel, same single row, same error message.
- Lock released, same win resubmitted: saved once, results = 1, status `solved`, commands 3.

## Findings for the architect

No product bug was found in items 1, 2, 3 or 5. The header slow-loris found by the first runs is fixed (PR #34) and re-verified in `t6`. One observation is open:

1. WebView2 browser-internal connections to Microsoft addresses during gameplay (item 4: in `t6`, 52.96.x.x:443 in 33 of 33 samples and 150.171.28.11:443 in 6 of 33). Either reword the checklist line to cover the application process, or address the WebView2 behavior.

Not run here: the NSIS-installed build (these runs use `target/release`) and any visible-window behavior.
