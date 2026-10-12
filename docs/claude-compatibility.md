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

## Additional scenarios

Three more `--scenario` values cover the remaining lifecycle claims. Executed results are recorded under Executed evidence below; a scenario stays unverified until a real run passes there. Use a fresh `--fixture` directory for each and the same `--claude`, `--bridge` and `--data-dir` arguments as above (shown with `$a` for brevity):

```powershell
$a = '--claude','C:\absolute\path\claude.exe','--bridge','C:\absolute\path\clawdle-bridge.exe','--data-dir','C:\absolute\checkout\.local\native-smoke-cli-app'
python scripts/claude-lifecycle-smoke.py @a --fixture 'C:\absolute\checkout\.local\native-smoke-cli-permission' --scenario permission
python scripts/claude-lifecycle-smoke.py @a --fixture 'C:\absolute\checkout\.local\native-smoke-cli-subagent' --scenario subagent
python scripts/claude-lifecycle-smoke.py @a --fixture 'C:\absolute\checkout\.local\native-smoke-cli-session-end' --scenario session-end
```

- `permission`: runs with `--permission-mode default` and only the `Write` tool (never a bypass or skip-permissions mode). The synthetic provider answers the first request with a `Write` tool use aimed at a file inside the fixture project. Nothing approves it. Accepted only if the journal holds a root `agent.needs_attention` event with `attentionKind: permission` (from `PermissionRequest` or a `permission_prompt` `Notification`) between the start and the terminal, exactly one correlated `Stop`, and the target file was never created. Claude may not raise `PermissionRequest` in headless `--print` mode; if it does not, the run fails with `permission_attention_not_journaled` and that result is the finding (the case then needs an interactive run).
- `subagent`: exposes only the `Agent` (or legacy `Task`) tool; the provider answers the first request with a tool use that starts one foreground child (`run_in_background: false`), the child's own request gets plain text. Accepted only if every `SubagentStop` is journaled with `scope: child`, none is root, no child event carries start or session-end semantics, and the root keeps exactly one start and one terminal. Journal order between the child `SubagentStop` and the root terminal is not checked: each async hook is a separate process, so delivery can reorder them.
- `session-end`: a normal success turn; additionally requires exactly one root `SessionEnd` (`agent.session_ended`) after the terminal. The wait extends until it appears (5 s). If headless `--print` does not fire `SessionEnd` before exit, the run fails with `expected_single_session_end`; interactive shutdown would then need a separate run.

Failed runs keep a sanitized `observedEvents` list (sequence, source event, scope, type) in `result.json` to show what actually fired.

Pure acceptance and provider logic is covered by `python -m unittest discover -s scripts/tests` (also run in CI) without launching Claude.

This verifies actual CLI hook dispatch and normalization against a local synthetic provider. It does not prove hosted-model behavior, interactive SessionEnd, permission attention, subagent lifecycle, native focus, sleep/resume, or other Claude versions. Those checks remain separate acceptance items. The [official hook reference](https://code.claude.com/docs/en/hooks) documents exec-form arguments, asynchronous hooks and prompt identity; execution evidence takes precedence over assumptions from the schema.

## Executed evidence

On 2026-10-12, Windows 11 Home 10.0.26200 and Claude Code 2.1.287 passed both scenarios using the checked-in harness and installed bridge SHA-256 `84D722FE2EC64F753DF6A6BB74D161FAE3E5945F86B1A715C8B62B7313E96392`. The running installed app hash was `7E9618C043BE89F0E553D935DEA8D8438589C86F383F26DFC4912ABB03FF9FAA`.

| Scenario | Actual journal sequence | CLI exit | Result |
| --- | --- | ---: | --- |
| Success | SessionStart (3), UserPromptSubmit (4), Stop (5) | 0 | Passed |
| Provider error | SessionStart (6), UserPromptSubmit (7), StopFailure (8) | 1 | Passed |

Each start/terminal pair shared a nonempty prompt ID and normalized to `agent.started` then `agent.turn_completed`; the error terminal carried `provider_error`. Each fixture received one `/v1/messages` request. Both reports passed ordered lifecycle, root scope, unrelated-hook execution, prompt-canary absence, removal of owned hooks, preservation of all original fixture settings, and unchanged global settings. No hosted model was invoked. Reports and isolated profiles are retained privately under `.local/native-smoke-cli-*-verified`.

The harness bounds subprocesses and retains sanitized failure and independent cleanup results. A report passes only when all acceptance and cleanup checks succeed. These runs establish the version/scenarios above; the separate limitations remain unverified.

### 2026-10-12: permission, subagent and SessionEnd on Claude Code 2.1.282

Windows 11 Home 10.0.26200, Claude Code 2.1.282 (the version installed on this host; earlier rows used 2.1.287). Bridge and app built from main `5637c04`: bridge SHA-256 `28556BEDE6EDE687BFFB3BCD40A3ED904B4451E7DAFB0416E7C77A74EDF20BD4`, app SHA-256 `8DE27F22653A09478430FAB07E289B95D1346044E6833AA665F2ED62EBCCD2CE`. The app ran hidden with `--hook-launch` in an isolated test profile.

| Scenario | Runs | Result |
| --- | ---: | --- |
| Success | 5 | Passed 5/5 |
| Permission | 1 | Passed: `PreToolUse`, then root `PermissionRequest` normalized to `agent.needs_attention`, then one correlated `Stop`. The `Write` target was never created |
| Subagent (foreground) | 6 | Passed 5/6 under the final acceptance rule, including one run that journaled the child `SubagentStop` after the root `Stop` (accepted; see above). One run **lost the root `PostToolUse` and `Stop` entirely**; they never reached the journal |
| Subagent (background, harness default before this change) | 1 | Root `Stop` arrived first, then child `SubagentStop`, then Claude started a **new root turn** (`UserPromptSubmit`, `Stop`) to deliver the result |
| SessionEnd | 2 | **Failed**: headless `--print` never journaled `SessionEnd`, also with the Clawdle hook made synchronous in the fixture. Unverified; needs an interactive run |

Findings that need product decisions:

- **Lost terminal in headless mode.** One headless run in about ten lost the root `Stop`. The bridge is installed as `async: true` with a 1 s timeout, and the likely cause is that the async hook does not finish before `claude --print` exits. Interactive sessions keep running after `Stop`, so this is unconfirmed there. A lost terminal leaves the race to the conservative interruption path.
- **Background subagents start a new root turn.** Claude delivers a background agent's result in a new turn that the user did not type. The app treats it as a new race start.

No hosted model was invoked. Reports and profiles are retained privately under `.local/native-smoke-cli-*-1012b`.
