# Native Claude Code compatibility checks

The verified starting target is Windows-native Claude Code **2.1.287**. Older versions, WSL, SSH and remote providers are not verified. Version numbers alone do not prove compatibility: the exec-form `command`/`args` handler and correlated `prompt_id` lifecycle inputs must execute successfully.

`scripts/claude-lifecycle-smoke.py` runs the actual installed Claude executable with Clawdle's actual packaged bridge and generated project hook configuration. It supplies its own isolated Claude configuration directory, explicit settings file, empty MCP configuration, no tools, no session persistence, and a synthetic API key. The provider is a small HTTP server bound to IPv4 loopback; it returns a fixed synthetic response or an explicit provider error. It never calls a hosted model. Global Claude settings are hashed before and after, without including their contents or hashes in the report.

Start the packaged app in an explicit test profile first (`CLAWDLE_TEST_MODE=1`, `CLAWDLE_DATA_DIR` set to a direct repository `.local/native-smoke*` directory). Then run:

```powershell
python scripts/claude-lifecycle-smoke.py `
  --claude 'C:\absolute\path\claude.exe' `
  --bridge 'C:\absolute\path\clawdle-bridge.exe' `
  --data-dir 'C:\absolute\checkout\.local\native-smoke-cli-app' `
  --fixture 'C:\absolute\checkout\.local\native-smoke-cli-success' `
  --scenario success
```

Use another fresh fixture with `--scenario provider-error` for StopFailure. The harness installs and removes hooks only inside its newly created project. An unrelated fixture hook must still execute, and unrelated settings must survive removal. Reports retain binary hashes, version, actual observed source events, sequence order, scope and whether turn identity was present. They omit raw prompts, transcripts, API credentials and session/turn identifiers. Fixtures are preserved; no existing project or global hook configuration is replaced.

The journal must contain real CLI SessionStart, UserPromptSubmit and the expected Stop/StopFailure, with exactly one correlated start and terminal event. A synthetic private-prompt canary must be absent. Silent hook exit alone is not accepted as proof of delivery.

This verifies actual CLI hook dispatch and normalization against a local synthetic provider. It does not prove hosted-model behavior, interactive SessionEnd, permission attention, subagent lifecycle, native focus, sleep/resume, or other Claude versions. Those checks remain separate acceptance items. The [official hook reference](https://code.claude.com/docs/en/hooks) documents exec-form arguments, asynchronous hooks and prompt identity; execution evidence takes precedence over assumptions from the schema.

## Executed evidence

On 2026-10-12, Windows 11 Home 10.0.26200 and Claude Code 2.1.287 passed both scenarios using the checked-in harness and installed bridge SHA-256 `84D722FE2EC64F753DF6A6BB74D161FAE3E5945F86B1A715C8B62B7313E96392`. The running installed app hash was `7E9618C043BE89F0E553D935DEA8D8438589C86F383F26DFC4912ABB03FF9FAA`.

| Scenario | Actual journal sequence | CLI exit | Result |
| --- | --- | ---: | --- |
| Success | SessionStart (3), UserPromptSubmit (4), Stop (5) | 0 | Passed |
| Provider error | SessionStart (6), UserPromptSubmit (7), StopFailure (8) | 1 | Passed |

Each start/terminal pair shared a nonempty prompt ID and normalized to `agent.started` then `agent.turn_completed`; the error terminal carried `provider_error`. Each fixture received one `/v1/messages` request. Both reports passed ordered lifecycle, root scope, unrelated-hook execution, prompt-canary absence, removal of owned hooks, preservation of all original fixture settings, and unchanged global settings. No hosted model was invoked. Reports and isolated profiles are retained privately under `.local/native-smoke-cli-*-verified`.

The harness bounds subprocesses and retains sanitized failure and independent cleanup results. A report passes only when all acceptance and cleanup checks succeed. These runs establish the version/scenarios above; the separate limitations remain unverified.
