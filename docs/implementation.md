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

All integrated web checks pass: **72 unit tests, nine browser flows, typecheck, lint and production build**. Native tests pass on Windows. The synthetic bridge benchmark measured **34.43 ms p95** and **40.02 ms maximum** across 30 warmed processes; measured binary hashes, fixture proof and limitations are in [native-smoke.md](native-smoke.md). This workstation measurement is not a universal performance guarantee.

## Remaining release gates

- Clean supported Windows machine with networking unavailable and WebView2 initially absent. The offline installer contains WebView2; installation on the already provisioned maintainer host does not prove this gate.
- Native GUI focus while typing, tray close/reopen, visual Save As and physical sleep/resume. Windows UI automation repeatedly failed on the installed app with `foreground window did not report a process id`, including after fresh handle selection and an ordinary shortcut-style launch. No coordinate/input workaround was used.
- Real Claude lifecycle/version compatibility beyond documented metadata fixtures and executable-version inspection. No model was invoked and no user global hooks were changed for these checks.
- Native/WebView2 working set, cold/warm presentation and idle CPU measurements under an identified workload.

No clean Windows VM/Sandbox is available in this environment. Keep the release a draft until the outstanding OS checks in [windows-smoke-checklist.md](windows-smoke-checklist.md) pass. Linux/macOS packaging, additional providers, multiplayer and an offline browser PWA remain outside the first release.
