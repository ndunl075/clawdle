# Packaged gameplay acceptance

Automated acceptance of the packaged `clawdle-desktop.exe` for the gameplay,
race-ordering, recovery, second-launch and accessibility items in
[windows-smoke-checklist.md](../windows-smoke-checklist.md). This record does
not edit that checklist; the architect decides what to tick.

Re-run with one command (waits for `.local/locks/machine.lock` in the main
checkout, runs hidden, never touches `~/.claude` or the real Clawdle profile,
never calls a hosted model):

```sh
node scripts/acceptance/gameplay.mjs --tag NAME            # all items, ~3 minutes
node scripts/acceptance/gameplay.mjs --only orderings --scenario hidden-stop   # one scenario
```

Evidence is written to `.local/native-smoke-gameplay-NAME/results.json`.
Files: `scripts/acceptance/gameplay.mjs` (driver), `gameplay-turn.py` (one real
Claude turn against a loopback provider that holds its reply until released),
`win32.ps1` (window visibility/foreground probes).

## Environment

| | |
| --- | --- |
| Date | 2026-10-13 04:19 UTC (2026-10-13 00:19 local), full run `run9` after the fixes. Baseline before the fixes: 2026-10-12 23:11 local, run `run4` |
| OS | Microsoft Windows 11 Home 10.0.26200 |
| Repository | `721eab7` = `0791f4b` (main with fixes #34, #35, #36, #37) merged into this branch |
| `clawdle-desktop.exe` sha256 | `dd8aaf0c02ecafb6f13912418e6f08c919e97371d2f7c65e1bb4f2467c5afc65` (release build of `721eab7` in this worktree) |
| `clawdle-bridge.exe` sha256 | `623d65ea3eb6b68e145272abcd3b8d7a5f4ed7233dc080f7aa2e0d83bcd55349` |
| Baseline binaries (pre-fix, `run4`) | desktop `572cfc8f…405f`, bridge `48e3df5e…8e36`, built from `1000849` |
| Claude Code | 2.1.282, real CLI, synthetic loopback provider (`ANTHROPIC_BASE_URL` = 127.0.0.1) |
| Node / driver | v22.21.0, Playwright `connectOverCDP` on WebView2, port 9343 |

The app was only ever launched with `--hook-launch`. Each profile is a fresh
`.local/native-smoke-gameplay-*` directory with `CLAWDLE_TEST_MODE=1`.

## Result per checklist item

Final run `run9` (fixed build): **127 of 127 checks pass**. Baseline run
`run4` (pre-fix build): 111 pass, 16 fail; every failure was a product finding
(below), none a harness error. The table records the pre-fix result and the
result on the fixed build.

| Checklist item | Result | Evidence |
| --- | --- | --- |
| Disconnected Daily and Endless, dictionary lookup | **PASS** | `AAHED` (guess list, not an answer) and `ABOUT` accepted and scored; `ZZZZZ` and `QQQQQ` rejected with "Not in the word list" and no guess consumed; an Endless puzzle solved and recorded as a win. No Claude or hook involved. |
| Close/reopen resume | **FAIL** (bug 1), **PASS** after #35 | After a crash-style kill and `--hook-launch` relaunch, the Daily (2 guesses) and Endless (1 guess) saves are quarantined: "This saved daily puzzle needs recovery". |
| Race: player-first | **PASS** | Solve seq 8 before Stop seq 9: `player_win`, ranked; the later Stop leaves it unchanged; one ranked result; UI "You beat Claude." |
| Race: agent-first | **PASS** | Stop before a solve: `agent_first`, ranked loss, puzzle kept playing with its row; a later solve sets only `continuedPuzzleSolved`, outcome unchanged, no ordinary result added. |
| Race: hidden Stop | **PASS with caveat** | Stop journaled and race resolved `agent_first` while the window was hidden; after the window returned (non-activating path), a solve seq 9 after Stop seq 8 did not win. Caveat: the product hide paths no-opped (bug 2), so the harness hid the window with a raw Win32 `SW_HIDE`. |
| Race: short turn | **PASS** (spec gap, bug 6) | Renderer frozen with CDP `Debugger.pause` while a whole real turn ran: `agent_first`, unranked, `not_presented`, no ranked result. UI shows "Claude finished first." plus Unranked, not "too short to race". |
| Race: two sessions | **PASS** | Second session stays an offer; active race and typed draft untouched; its Stop resolves only that offer (unranked); the first race stays winnable (`player_win`); one ranked result. |
| Race: child Stop | **PASS** | `SubagentStop` journaled with scope child; race stayed running; the root Stop then ended it `agent_first`. |
| Provider error | **PASS** | `StopFailure`: `interrupted`, unranked, no ranked result, UI "Race ended without a ranked result." |
| Crash recovery | **PASS for the race, FAIL for the puzzle** | Kill mid-race and relaunch: race `interrupted` (not `agent_first`); a late Stop for the same turn cannot rewrite it. Puzzle not preserved (bug 1). |
| Missed notification | **PASS for the race, FAIL for the puzzle** | Stop delivered while the app was down: hook exited 0, claude exit 0, Stop never journaled; after relaunch the race is `interrupted`, no invented outcome. Puzzle not preserved (bug 1). |
| Session end | **Not verifiable** | Claude 2.1.282 headless does not emit `SessionEnd`: the harness `session-end` scenario journaled only `SessionStart, UserPromptSubmit, Stop`. Stays unchecked. |
| Sleep/resume | Excluded | Manual. |
| Hook second launch | **PASS** | A second `--hook-launch` exits 0, the window stays hidden, the first instance and its endpoint stay up, the foreground window never changes (also with the window already visible). Limit: in `run4`/`run5` no window was in the foreground (foreground pid 0, locked or idle desktop), and a harness Notepad could not take the foreground, so only "app never became foreground" was observable there. The earlier full run `run3` had a user window in front (`before=9548`, `seen={"9548":88}`) and passed. |
| Keyboard navigation | **FAIL** (bugs 3, 4) | Tab order is header, mode tabs, then keys, in reading order; 38 stops, none unnamed, every button has a visible focus ring, no trap. Physical keys type and Backspace deletes; Escape closes dialogs. Enter does not activate buttons (bug 3); focus lands on `BODY` after a dialog closes (bug 4). |
| Narrow viewport | **PASS** to 320 px | 360x600 and 320x568: no horizontal scroll, keys and header inside the viewport, keys 29.5 and 24.0 px. Observation: 280x480 keys are 20 px (below the 360 px window minimum). |
| Reduced motion, high contrast applied | **PASS** | Both settings set the `app` classes, add tile symbols, and persist across a restart. The app has no tile animation to remove (animation/transition already `0s`). The OS `prefers-reduced-motion` and `forced-colors` are not followed; only the in-app toggles are. |
| Colour contrast | **FAIL** (bug 5) | Measured tile text contrast: correct 2.78:1, present about 2.07:1 (high contrast 2.73 / 1.93), absent 4.21:1. Spec asks for dark text on green/yellow. |

axe-core is not in `node_modules`, so role/label checks were manual: `main`,
`nav`, grid and row labels, labelled tiles, `aria-current` mode, polite live
regions, timer not live, image alt text, `lang="en"`. The `<dialog>` has a
visible `h2` but no `aria-label`/`aria-labelledby`. An ARIA snapshot is in
`a11y-aria-snapshot.yml` in the evidence folder.

## Finding status on the fixed build (`run9`)

| # | Finding | Status | Evidence on `run9` |
| --- | --- | --- | --- |
| 1 | Restart quarantines in-progress puzzles (`+00:00` vs `Z`) | **Fixed by #35** | Daily (2 guesses) and Endless (1 guess) survive a kill and `--hook-launch` relaunch, nothing quarantined, UI shows the rows; crash-recovery and missed-Stop puzzles are preserved. |
| 2 | Auto-shown window cannot be hidden | **Fixed by #37** | A window close message hides the auto-shown window with background integration on; the harness no longer needs its raw `SW_HIDE`. |
| 3 | Enter does not activate focused buttons | **Fixed by #36** | Enter opens the dialog and closes it from the Close button. |
| 4 | Focus lost to `BODY` after a dialog closes | **Fixed by #36** | Focus returns to the opener (`How to play`). |
| 5 | Tile text contrast below 3:1 | **Known limitation** (accepted by the maintainer; High contrast mode exists) | Measured: correct 2.78:1, present about 2.07:1, absent 4.21:1; high contrast 2.73:1 / 1.93:1. Recorded, not failed. |
| 6 | No "too short to race" message | **Fixed by #36** | UI shows "That turn was too short to race." |
| - | Bridge and receiver budget (#34) | Merged before this run | Receiver-down hook path still exits 0 in the missed-Stop check. |

Probe note: `scripts/acceptance/win32.ps1` must select the window of class
`Tauri Window`. The first titled window of the process can be the hidden
single-instance helper (`org.clawdle.desktop-sic`), which made the earlier
`gui-checks.mjs` visibility and close results unreliable. This script already
selects the right class.

## Product findings as first observed on the pre-fix build (`run4`)

1. **Every restart quarantines all in-progress puzzles (high).** The Rust
   repository stamps times with `chrono::Utc::now().to_rfc3339()`, giving
   `2026-10-13T02:34:29.069059+00:00`. `validateSavedPuzzle`
   (`packages/game/src/index.ts`) requires `/T.*Z$/`, so each saved game fails
   `invalid_metadata` on the next process start and moves to
   `quarantinedGames`. Repro: launch with `--hook-launch`, guess one word in
   Daily, kill the process, relaunch: no active game, feedback "This saved daily
   puzzle needs recovery", `games` empty. The web build uses `toISOString()`,
   so unit tests miss it. Affects Daily, Endless and race puzzles after any
   restart or crash. Suggested fix: emit `Z` timestamps from the repository
   (`SecondsFormat::Millis, true`) and accept `+00:00` when reading existing saves.
2. **Auto-shown window cannot be hidden (high for tray behaviour).** After a
   race auto-show (raw `ShowWindow(SW_SHOWNOACTIVATE)`), neither a window close
   message with background integration enabled (`bridge.json`
   `backgroundIntegration: true`) nor the `native_hide` command hides it;
   `IsWindowVisible` stays true. Likely cause: Tao's cached visibility flag
   never saw the raw show, so `hide()` is a no-op. This also makes earlier
   tray-close evidence that relied on `win32.ps1`'s first-titled-window lookup
   suspect (it can select the hidden single-instance helper window; the probe
   here selects the `Tauri Window` class).
3. **Enter never activates a focused button (WCAG 2.1.1).** The `main`
   `onKeyDown` calls `preventDefault()` on Enter for every non-input target, so
   Enter on a header button, mode tab or dialog Close does nothing; Space works.
4. **Focus is lost after closing a dialog** (`BODY`, not the surface or the
   trigger), even with no Tab presses in between.
5. **Tile text contrast below 3:1** for correct and present tiles in both themes.
6. **Short turns are not explained.** Spec §11 step 4 asks to show that the turn
   was too short to race; the UI shows "Claude finished first." with an Unranked badge.

## Observations and limits

- Run `run1` showed the app's own pid as the foreground window for two of
  seven race scenarios (no transition timestamps were captured then); it did not
  reproduce in `run3`, `run4`, nor in the re-runs, which sample transitions. The
  cause is unknown and may have been the person using the machine; a rerun
  attended is advisable.
- Hidden Stop used a raw Win32 hide (finding 2); short turn used a frozen
  renderer. Both are harness devices, not product behaviour.
- Tab inside a modal dialog left the dialog on 2 of 6 presses (WebView2 hands Tab
  to the host); recorded as an observation, not judged a failure.
- A race only foregrounds when no unfinished puzzle is active (Beat Claude tab
  selected first); otherwise a new turn is a late-join offer, as the
  architecture's multi-session rules describe.
- `run2` aborted when another worker's app instance held the single-instance
  slot; its results are discarded.
- Not covered here: IDE focus loss, tray reopen, clean-machine install, ACLs,
  bridge timing (other checklist items and workers).
