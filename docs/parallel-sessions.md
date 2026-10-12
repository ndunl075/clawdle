# Parallel worker sessions

Rules for Claude Code worker sessions that build Clawdle in parallel. Each brief
names the files a session owns; this document holds the rules they all share.

## Worktrees and branches

- Work only in your own git worktree and branch, cut from current `main`.
- Edit only the files your brief says you own. If you need to touch a file
  another session owns, stop and report instead of editing it.
- Bring an open PR up to date by merging `main` into it. Do not rebase and
  force-push a branch that has been reviewed.
- One PR per task, based on `main`. Never stack a PR on another feature branch.

## Filesystem safety

- `.local/` holds private test profiles, fixtures and evidence. Never commit it.
- Never delete a fixture or profile directory. Harnesses create fresh ones.
- Never recursively delete a folder that may contain junctions or symlinks
  (for example `node_modules` from pnpm) without removing the links first.
- Never touch the user's global Claude settings (`~/.claude`) or real projects.

## Exclusive machine resources

The packaged app, its loopback receiver, installed builds and GUI windows are
shared by the whole machine. Before launching any of them, create
`.local/locks/machine.lock` with your session name and the time, in the main
checkout (`C:\Users\ndunl\Documents\clawdle`). If it already exists, wait or
report instead. Delete your lock when you finish.

Do not open windows, launch the desktop app, install builds or run real Claude
unless your brief explicitly allows it. The maintainer uses this computer for
their own work. Headless checks (typecheck, lint, Vitest, Cargo, Playwright,
Python unit tests) are always allowed.

## Evidence and docs

- Record only checks that actually ran, with date, OS build, versions and hashes.
  An unexecuted check stays unchecked.
- Append evidence to the doc your brief names (for example
  `docs/claude-compatibility.md` or `docs/native-performance.md`). Edit the shared
  ledger `docs/implementation.md` or `docs/windows-smoke-checklist.md` only if
  your brief assigns it to you.
- Never commit credentials, real prompts, responses, transcripts or private paths.

## Checks before opening a PR

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm test:rust
```

Add any harness-specific test command your brief names. Include the actual
results and material limitations in the PR description.

## Review gate

- Changes that touch persistence, migrations, the native journal, hook settings
  merge/removal, crypto, ACLs/permissions, native file effects or recovery stop
  at an open PR for architect review. Do not merge them yourself.
- Low-risk work (tests, docs, UI, CI, measurement tooling that cannot affect the
  product) may self-merge once CI is green on the PR's exact head SHA, if the
  brief allows it.
