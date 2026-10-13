# Native Windows performance measurement

Run `scripts/native-performance.ps1` from Windows PowerShell 5.1 or PowerShell 7 with an explicit built or installed Clawdle executable and a **new**, absolute fixture path directly beneath this checkout's `.local`, named `native-smoke*`. Close Clawdle first: its single-instance behavior would otherwise redirect the launch. The harness never stops a pre-existing instance, changes Claude hooks, sends synthetic hooks, or invokes a model.

```powershell
pwsh -NoProfile -File scripts/native-performance.ps1 `
  -App 'C:\absolute\path\Clawdle.exe' `
  -DataDir 'C:\absolute\checkout\.local\native-smoke-performance-001' `
  -Launches 3 -DurationSeconds 60 -SampleIntervalMs 1000
```

Python 3 with its standard `sqlite3` module must be available. `-Python` can select an absolute executable. The first actual application returned by `Get-Command` is used. `-ReadinessTimeoutSeconds` defaults to 30. Launch count is 1–10, sustained duration 10–3600 seconds, and interval 100–10000 ms. Ordinary launch requests a visible window, but the harness does not verify visibility; confirm that separately and leave it idle for comparable runs. Do not type, minimize it, switch modes, resize it, or put the machine to sleep during a run. Record hardware, power plan, foreground/background status, and other workload separately when comparing machines.

The script preserves its ownership marker, independent `launch-01`, `launch-02`, etc. app/WebView2 profiles, `progress.json`, and `performance.json`. Progress reports the current phase, launch, launched PID, elapsed time, and sample count; it contains no tokens or raw process command lines. The performance report is atomically refreshed after every sustained sample and around cleanup. `status: running` or `failed` retains partial measurements for diagnosis and cannot establish a completed acceptance result. Use another fresh fixture directory for the next invocation. No fixture is deleted or reused. Reparse points in the executable, fixture, and inspected file paths are rejected. Keep these fixtures private: native storage may contain connection credentials even though the performance report excludes them.

Readiness is **process launch to observation of a durable, valid initial daily puzzle checkpoint**, read through a SQLite read-only connection. The checkpoint must contain a fresh playing daily puzzle with no guesses, expected rules/dictionary versions, valid date, and the frozen schedule's answer. The fixture receiver must report the exact launched PID and a runtime epoch, and the process must match the selected executable, creation time, and current Windows user. This demonstrates persisted puzzle initialization; it does **not** prove first visible pixels, correct layout, input responsiveness, window focus, or first meaningful paint. Polling, Python startup, CIM enumeration, and query overhead increase the observed duration. A missing checkpoint fails the run; elapsed time is never substituted as a successful readiness result.

Launch 1 is the first actual process startup **in this harness invocation**, with uncontrolled OS cache state. Executable SHA-256 hashing occurs before launch and can warm its OS file cache. Launches 2+ are labeled repeated OS-warmed launches. Every launch uses a fresh app/WebView2 profile to require new durable puzzle initialization; these are not restored-profile launches. The harness does not reboot Windows, flush file caches, or claim any result is a cold boot. To study genuine first-machine launch, arrange that condition externally and retain its provenance; the same readiness limitations still apply.

After readiness, the harness measures a sustained idle interval and retains each sample's elapsed time, per-process PID/creation identity, working set, private bytes, and cumulative CPU seconds. It discovers the native process and WebView2 descendants through Windows CIM parent/creation relationships. Only verified current-user native/WebView2 processes enter the totals. Aggregate working set can count shared pages multiple times; private bytes measure private committed address space, not physical residency. CPU percentages are reported both relative to one logical core (can exceed 100%) and to all logical processors. The first baseline is excluded; the summary CPU mean is an arithmetic mean of measured intervals. Sampling/inspection overhead makes interval timing approximate. Short-lived or exiting processes between samples can escape CPU accounting. System services, kernel/driver memory, and unrelated applications are outside the measured tree.

Cleanup terminates only processes launched by this invocation or their captured, verified descendants. One fresh process-tree snapshot supplies cleanup candidates. Before each termination an anchored native handle rechecks creation time and executable path, a bounded CIM call verifies the current-user SID, and the fixture marker is checked. No additional full enumeration is performed for each cleanup PID. CIM operations default to an eight-second timeout (`-CimTimeoutSeconds`, 1–10); timeouts fail the run rather than silently omit unreadable processes. Snapshots request only PID, parent, creation time, and executable path. Sample CPU denominators use actual wall-clock intervals, including slow enumeration and report writes; the requested sample interval is not substituted. It does not kill by application name or trust an arbitrary PID in a profile. Root termination prevents further intentional child creation; an exceptional or unverifiable process is preserved rather than killed. Cleanup is abrupt, so these fixtures are measurement artifacts, not valuable game profiles. If verification or cleanup fails, inspect the retained report/fixtures and process list manually before rerunning; no arbitrary cleanup command is provided.

The JSON includes executable SHA-256, OS/PowerShell/Python versions, logical processor count, all successful launch samples, and any failure. A failed launch cannot establish an acceptance metric. This tool's static validation does not constitute a native performance result. Root acceptance must execute it against the final packaged build and retain the report, then separately verify visible native UI, typing, and focus behavior.

## Descendant inspection and self-test

A WebView2 child can exit between process enumeration and inspection, or report an empty `ExecutablePath` through CIM. The harness handles both without weakening verification:

- A descendant that has exited (or whose PID was recycled to a different creation time) is dropped from that sample and counted in the sample's `exitedDuringSample` (and the launch's `exitedObservations`). It is not an error.
- A descendant that is alive with an empty CIM path is retried through `Get-Process .Path` and `QueryFullProcessImageName` (at most three 100 ms attempts per enumeration). A recovered path must still be this app's executable or `msedgewebview2.exe`, free of reparse points, and owned by the current user; anything else still fails the run.
- If the path stays unrecoverable the process is **not** included in totals or ever terminated, and is counted in the sample's `unverified` and the launch's `unverifiedObservations`. Any such observation makes the launch and the report `status: incomplete`, never `completed`; an incomplete report is not an acceptance result. Children of an unverified process are not discovered either, which is why the run cannot pass.
- Cleanup only terminates processes whose path was verified (by either source) and re-checks it against the live process before each kill.

The classification logic lives in `scripts/native-performance.lib.ps1` and is exercised with injected fake process rows (exited, empty path recovered, empty path unrecoverable, foreign executable) by a headless self-test that launches nothing and writes no files. It is not wired into CI:

```powershell
powershell -NoProfile -File scripts/native-performance.tests.ps1
```

## Hidden (tray) launch and memory targets

The primary metric is **summed private bytes** across the native process and its WebView2 children (see `ARCHITECTURE.md`): at most 200 MB visible or hidden to tray, where MB is MiB (1048576 bytes). Summed working set is recorded for information only and never gates.

`-HookLaunch` starts the app with `--hook-launch`, so it stays hidden in the tray and never takes focus. Use it for any run on a machine someone is working on; the default launch is visible and steals focus.

```powershell
pwsh -NoProfile -File scripts/native-performance.ps1 `
  -App 'C:bsolute\path\Clawdle.exe' `
  -DataDir 'C:bsolute\checkout\.local
ative-smoke-performance-hidden-001' `
  -HookLaunch
```

Report fields added:

- `presentation`: `hidden` with `-HookLaunch`, otherwise `visible`. `launchArguments` lists the arguments passed to the app. Hidden state is requested, not independently verified.
- Per launch: `peakPrivateBytes`, `meanPrivateBytes` (over the sustained samples), `privateBytesTargetBytes`, and `privateBytesTargetPass` (peak at or under the target for the presentation). `peakWorkingSetBytes` stays informational.
- Report level: `primaryMetric`, `privateBytesTargetBytes`, and `privateBytesTargetPass`. The latter is `true` only when the report is `completed` and every launch passed, `false` if any launch failed or was not measured, and `null` for a `running`, `failed` or `incomplete` report (no verdict).
- `runnerNote`: free text copied from the `CLAWDLE_PERF_RUNNER_NOTE` environment variable, used by CI to label the environment.

## CI measurement (non-gating)

`.github/workflows/native-performance.yml` runs on `workflow_dispatch` and a weekly schedule. It builds the desktop app, then runs the harness once visible and once with `-HookLaunch`, each in a fresh `.local/native-smoke-ci-*` fixture, and uploads both `performance.json` reports as artifacts. It never gates merges. The numbers come from a **Windows Server runner (GitHub-hosted `windows-latest`), not Windows 11**, with shared virtualised hardware and uncontrolled background load: treat them as a trend and a sanity check, not release acceptance evidence. The harness's reparse-point, ownership-marker and executable-path checks run unchanged on the runner.

The self-test also covers launch-argument construction, presentation, and target evaluation:

```powershell
powershell -NoProfile -File scripts/native-performance.tests.ps1
```

## Hidden-state evidence on Windows 11 (2026-10-12)

Windows 11 Home 10.0.26200, 16 logical processors, Windows PowerShell 5.1.26100. `-HookLaunch`, 3 launches of 60 s at 1 s sampling, 0 unverified observations.

| Build | App SHA-256 | Peak private (per launch) | Mean private | Peak working set |
| --- | --- | --- | --- | --- |
| main `5637c04` | `8DE27F22…` | 186.2, 182.8, 188.6 MiB | 180.1–185.9 MiB | 403.8–413.4 MiB |
| plus hidden-start memory level | `0E4237E8…` | 187.6, 182.9, 183.7 MiB | 180.8–184.2 MiB | 381.4–389.2 MiB |

Both runs fail the 120 MB hidden target. Applying WebView2 `MemoryUsageTargetLevel=Low` at a hidden start trims about 20 MiB of working set but leaves private bytes unchanged. The GitHub-hosted runner reported about 120 MiB for the same state; it has no physical GPU, so it is not representative of a laptop.
