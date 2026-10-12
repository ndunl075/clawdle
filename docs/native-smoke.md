# Reproducing native protocol and hook measurements

Run `scripts/native-smoke.ps1` with PowerShell 7 on a Windows maintainer machine. It requires a built desktop executable, its matching native bridge, and Python 3 for read-only SQLite inspection. These are development checks; installed gameplay does not require PowerShell or Python.

```powershell
./scripts/native-smoke.ps1 `
  -App "$PWD/target/release/clawdle-desktop.exe" `
  -Bridge "$PWD/target/release/clawdle-bridge.exe" `
  -DataDir "$PWD/.local/native-smoke-protocol" `
  -StartApp -StopStartedApp
```

Close another running Clawdle instance before starting a separate fixture profile. The app's single-instance policy deliberately prevents parallel production instances with different profiles. Without `-StartApp`, the script uses an already running receiver only when its endpoint PID matches the explicitly selected executable. `-StopStartedApp` terminates only the child process this invocation created. Neither option modifies global Claude settings or launches a model.

The fixture directory must be an absolute repository-owned `.local/native-smoke*` path without reparse-point ancestors. Both executables receive `CLAWDLE_TEST_MODE=1` and `CLAWDLE_DATA_DIR` explicitly; WebView2 uses that fixture's `webview` subdirectory. Fixture files are retained for inspection. Tokens stay in memory/private files and never enter output. Requests bypass HTTP proxies and target `127.0.0.1` only. Run from an ordinary maintainer PowerShell session: restricted automation shells can prevent WebView2 initialization. Use a fresh fixture after an interrupted launch if the old browser profile remains locked.

The script verifies authenticated health and runtime epoch, duplicate event sequence identity, rejection of wrong tokens, browser Origin, unexpected Host, query credentials, oversized bodies and invalid protocol versions. It delivers synthetic start, attention, child completion, provider failure and root completion through the actual bridge executable. A read-only SQLite query verifies delivery count, receipt order, scope/failure normalization and absence of a synthetic private-content canary. A successful silent bridge exit alone is insufficient evidence of delivery.

Three processes warm the executable before 30 measured processes by default. The reported duration begins immediately before process creation and ends after silent process exit, including startup, stdin, local delivery and shutdown. The script reports minimum, nearest-rank p95, maximum, whether p95 is below the architecture's 50 ms running-receiver goal, and whether every measured process finishes within 300 ms. It does not hide misses or substitute internal HTTP latency for whole-process latency. Increase `-Samples` up to 200 for another explicitly recorded run.

Record the complete JSON output alongside the machine/Windows version, current load and build configuration. Executable SHA-256 hashes identify the measured artifacts. The result characterizes that machine, those binaries and that workload. A single sample set does not establish a universal execution deadline or percentile guarantee under arbitrary OS scheduling.

This check provides no evidence of real Claude lifecycle compatibility, hardware suspend/resume delivery, IDE focus preservation, installer behavior, clean-machine offline installation or desktop working-set size. Those checks remain separate native acceptance items. Unit tests exercise native power registration and injected callback types without suspending the maintainer's computer.

## Recorded packaged run

On 2026-10-12, the maintainer workstation (Windows NT 10.0, build 26200) ran the release executable and bridge directly from the generated release resource directory. No Clawdle instance was running beforehand. The script launched an isolated `.local/native-smoke-benchmark3` profile and stopped only its own app process afterward. Other workstation load was not controlled. The run used three warmup processes and 30 measured processes; min **27.42 ms**, nearest-rank p95 **34.43 ms**, max **40.02 ms**. This run met the 50 ms p95 goal and all measured processes finished within 300 ms.

All protocol checks passed. Read-only SQLite inspection found all 39 expected synthetic events, stable duplicate receipt sequence identity, ordered unique sequences, preserved child scope, normalized provider-failure reason, and no raw private-content canary.

Measured app SHA-256: `9FCE7C4F903390DA2FA14FA76AAA524DB051FD725CA8BE9F914ADAE5480276E6`.

Measured bridge SHA-256: `84D722FE2EC64F753DF6A6BB74D161FAE3E5945F86B1A715C8B62B7313E96392`.

These hashes identify the measured build before the later durable test-profile initialization change. The script supplied its own isolated WebView2 environment for this run. This evidence covers synthetic local protocol execution only, with the limitations above.

## Final installer verification

The final offline installer was installed into `.local/installed-smoke` on Windows 11 Home 10.0.26200 on 2026-10-12. The existing host WebView2 runtime was present. Installation returned exit code 0; this does not prove installation on a clean machine without that runtime.

The installed binaries passed the same protocol and read-only journal checks with 39 expected events. Three warmup processes preceded 30 measured hook processes: min **24.32 ms**, nearest-rank p95 **31.68 ms**, max **31.92 ms**. The app used a fresh `.local/native-smoke-final` test profile. No real Claude hooks or models were invoked.

Installed app SHA-256: `7E9618C043BE89F0E553D935DEA8D8438589C86F383F26DFC4912ABB03FF9FAA`.

Installed bridge SHA-256: `84D722FE2EC64F753DF6A6BB74D161FAE3E5945F86B1A715C8B62B7313E96392`.

Final standard installer SHA-256: `360e6d5833febe1c26f86ab02eb522f126f6c47c67290b36f114cfec2c8af737`.

Final offline installer SHA-256: `10a88a646d3fec627da17e35d851f8ca737910b7f3b0d772d9322f5c6a1d753d`.

At 16:31 UTC, a 10.005-second idle sample of the installed app and all six WebView2 descendants measured **407.17 MiB summed working set**, **185.75 MiB private bytes**, and **0.00 seconds reported CPU time**. The workload was the initial Daily checkpoint after the synthetic protocol smoke, with no input or animation during the sample. Process ancestry was captured before sampling and all seven processes remained alive at its end. Summed working sets can double-count shared pages; this is a short host-specific sample, not a sustained idle CPU guarantee. The architecture's below-150-MB working-set aim was **not met**. Cold launch and warm auto-show presentation remain unmeasured.

The smoke helper selects the first executable resolved for Python, so a second Windows Store Python alias on PATH does not combine two paths into an invalid command.

## Sustained baseline attempt

On 2026-10-12, `scripts/native-performance.ps1` measured the same installed app hash above using fresh profiles in the private `.local/native-smoke-performance-baseline` fixture. Windows 11 Home build 26200 had 28 logical processors; other workstation workload and OS caches were uncontrolled. The original harness completed two idle intervals before failing on launch 3 with `Cannot verify a descendant executable.` Its report is retained; the invocation **failed** and does not establish the full performance acceptance gate.

| Launch | Interval | Samples | Peak summed working set | Peak private bytes | Mean machine CPU |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 64.37 s | 6 | 396.10 MiB | 168.32 MiB | 0% reported |
| 2 | 60.73 s | 6 | 396.00 MiB | 171.08 MiB | 0% reported |

These samples cover the initial visible Daily workload without input, hooks or models. Slow CIM inspection produced sparse samples despite the requested 1-second interval. Zero reported CPU reflects measured process-counter deltas and their resolution, not proof of zero work. Shared pages can appear in multiple working sets. The working-set aim remains unmet. Checkpoint observations took about 132 seconds, dominated by inspection overhead; they are unsuitable evidence for the 2-second visible cold-launch aim. No warm auto-show pixels were timed.

The follow-up harness bounds CIM queries, retains atomic progress and partial reports, and reduces repeated cleanup enumeration. It requires a new executed run; those tooling changes do not repair or upgrade this failed result. The installed binary predates the UI timer optimization merged in PR #16.
