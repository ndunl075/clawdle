# Implementation and verification ledger

The architecture remains the acceptance specification. Features land through separate pull requests with the owner's standing merge authorization. Implemented behavior and executed platform checks are recorded separately.

| Feature | Implementation | Executed verification |
| --- | --- | --- |
| Workspace and reproducible tooling | Delivered | Pinned pnpm install; TypeScript and ESLint pass |
| Dictionary and game rules | Delivered | 41 engine tests; pinned-source regeneration; 7,047 guesses, 912 curated answers and frozen daily entries |
| Standalone controller and storage | Delivered | 23 controller, three statistics and five IndexedDB tests; atomic persistence/conflicts/recovery and reset boundaries |
| Shared playable interface | Delivered | Nine Chromium flows: Daily/share/reload, mouse/invalid input, settings/narrow layout, no agent probing, both race orderings, UTC rollover, compact keyboard, incompatible-save recovery export |
| Native protocol and hooks | Delivered | Authenticated loopback, strict allowlist, private ACLs, bounded mailbox, owned settings merge/removal; actual synthetic packaged bridge smoke |
| Ordered races and timing | Delivered | Hidden/reordered boundaries, session/child isolation, terminal immutability, conservative interruption; real Windows power callback registration with injected boundaries |
| Desktop lifecycle and export | Delivered | Native Save As validation/UTF-8/cancellation helpers, standalone/tray policy, geometry and focus policy; 28 Cargo tests total |
| Windows packaging | Standard and offline installers built | Offline variant installed into an isolated directory with exit 0 on Windows 11 Home build 26200; installed frontend initialized a valid Daily checkpoint |
| Branding and light theme | Delivered | Original replacement crab/C tile mark, Windows icon, favicons; Wordle light palette; real browser gameplay screenshot |
| Speedrun | Delivered | Strict deadline, skip, transition and interruption tests; optional setting |
| Documentation, licensing and CI | Release preparation | Guides, lock-verified notices for 847 dependencies, artifact/version guards, checksums and draft-release workflow |

All integrated web checks pass: **77 unit tests, nine browser flows, typecheck, lint and production build**. Native tests pass on Windows. The synthetic bridge benchmark measured **34.43 ms p95** and **40.02 ms maximum** across 30 warmed processes; measured binary hashes, fixture proof and limitations are in [native-smoke.md](native-smoke.md). This workstation measurement is not a universal performance guarantee.

## Remaining release gates

- Clean supported Windows machine with networking unavailable and WebView2 initially absent. **Decision (2026-10-12): not a v0.1.0 blocker.** No clean machine or VM is available, so v0.1.0 ships with this documented as unverified in the release notes. The offline installer contains WebView2; installation on the already provisioned maintainer host does not prove this gate.
- Native GUI focus while typing, tray close/reopen, repeatable Save As and physical sleep/resume. Later UI revalidation displayed the actual game and native export dialog, and a valid export was written. Foreground interference prevented reliable completion of dialog selection/cancellation. The earlier helper error did not reproduce; these OS checks remain incomplete.
- Broader real Claude lifecycle compatibility: actual Claude Code 2.1.287 now passed success and provider-error turns against a synthetic loopback provider, preserving unrelated/global settings. Permission, subagent and interactive SessionEnd remain unverified. See [claude-compatibility.md](claude-compatibility.md).
- Cold/warm visible presentation and repeatable sustained idle CPU measurements. A longer attempt captured two 60-second intervals near 396 MiB peak summed working set and about 170 MiB private bytes before descendant verification failed on launch 3. The memory target is now private bytes, at most 200 MB visible or hidden (decision 2026-10-12). Windows 11 hidden runs measured 183–189 MiB peak (see native-performance.md); a visible laptop run is still required; zero measured CPU is limited by sampling resolution. See [native-smoke.md](native-smoke.md) for retained partial evidence and limitations.

No clean Windows VM/Sandbox is available in this environment. Keep the release a draft until the outstanding OS checks in [windows-smoke-checklist.md](windows-smoke-checklist.md) pass. Linux/macOS packaging, additional providers, multiplayer and an offline browser PWA remain outside the first release.
