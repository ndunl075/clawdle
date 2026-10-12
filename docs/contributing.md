# Contributing

Read ARCHITECTURE.md. Preserve dependency direction: UI → app-core → game/contracts.
Platform packages implement injected ports. The game engine is pure TypeScript;
Rust must not duplicate scoring rules.

Install pinned dependencies and run typecheck, lint, Vitest, Cargo tests, browser
E2E, and reproducibility checks before release. Each feature uses a separate PR.
Include the behavior change, actual checks, and material limitations.

Never edit `daily-v1.json` to reorder or append a published schedule. New
dictionaries must preserve old answer IDs and resumable puzzle versions.
Word-source updates are explicit maintainer work, separate from builds.

Use synthetic sanitized hook fixtures. Do not commit credentials, real prompts,
responses, transcripts, or private project data. A Stop fixture represents an
observed turn boundary, never verified task success.

OS behavior needs packaged Windows tests. Browser tests do not prove focus,
tray lifecycle, ACL protection, WebView2 installation, or no outbound native
traffic. Use the native checklist and record what actually ran.
