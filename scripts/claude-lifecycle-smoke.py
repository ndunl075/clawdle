"""Run real Claude Code against a local synthetic provider; never a hosted model."""
import argparse
import hashlib
import http.server
import json
import os
import re
from pathlib import Path
import sqlite3
import subprocess
import sys
import threading
import time
import uuid

SCENARIOS = ['success', 'provider-error', 'permission', 'subagent', 'session-end']
TEXT = 'Synthetic local compatibility fixture.'
CHILD_MARKER = 'SYNTHETIC_CHILD_TASK'
PERMISSION_TOOL = 'Write'
PERMISSION_TARGET = 'permission-target.txt'
SUBAGENT_TOOLS = ['Agent', 'Task']
TERMINALS = ['Stop', 'StopFailure']
# Final journal event each scenario waits for before evaluating (bounded by a deadline).
AWAITED = {'success': 'Stop', 'provider-error': 'StopFailure', 'permission': 'Stop', 'subagent': 'Stop', 'session-end': 'SessionEnd'}
LIMITATIONS = {
    'success': 'No permission, subagent, SessionEnd, interactive-session, focus, or sleep claim.',
    'provider-error': 'No permission, subagent, SessionEnd, interactive-session, focus, or sleep claim.',
    'permission': 'Headless --print mode only; whether Claude raises permission attention there is what this run measures. No approval is given, no interactive-session, subagent, SessionEnd, focus, or sleep claim.',
    'subagent': 'Headless --print mode with one synthetic child; no permission, SessionEnd, interactive-session, nested-subagent, focus, or sleep claim.',
    'session-end': 'Headless --print mode only; interactive-session shutdown reasons are not claimed. No permission, subagent, focus, or sleep claim.',
}


def tool_names(data):
    return [tool.get('name') for tool in data.get('tools') or [] if isinstance(tool, dict)]


def message_text(message):
    content = message.get('content')
    if isinstance(content, str):
        return content
    return ' '.join(str(block.get('text', '')) for block in content or [] if isinstance(block, dict) and block.get('type') == 'text')


def has_tool_result(data):
    return any(isinstance(block, dict) and block.get('type') == 'tool_result'
               for message in data.get('messages') or [] if isinstance(message.get('content'), list) for block in message['content'])


def is_child_request(data):
    first = next((message for message in data.get('messages') or [] if message.get('role') == 'user'), {})
    return CHILD_MARKER in message_text(first)


def planned_tool_use(scenario, data, project):
    """Return (name, input) when this request should ask Claude to run a tool, else None."""
    if has_tool_result(data) or is_child_request(data):
        return None
    names = tool_names(data)
    if scenario == 'permission' and PERMISSION_TOOL in names:
        return PERMISSION_TOOL, {'file_path': str(Path(project) / PERMISSION_TARGET), 'content': 'must not be written'}
    if scenario == 'subagent':
        name = next((candidate for candidate in SUBAGENT_TOOLS if candidate in names), None)
        if name:
            return name, {'description': 'Synthetic child', 'prompt': CHILD_MARKER, 'subagent_type': 'general-purpose'}
    return None


def provider_response(scenario, data, project, count_tokens=False):
    """Pure synthetic provider: (status, content type, body bytes)."""
    if count_tokens:
        return 200, 'application/json', json.dumps({'input_tokens': 1}).encode()
    if scenario == 'provider-error':
        return 400, 'application/json', json.dumps({'type': 'error', 'error': {'type': 'invalid_request_error', 'message': 'Synthetic local provider failure'}}).encode()
    tool = planned_tool_use(scenario, data, project)
    message = {'id': 'msg_local_fixture', 'type': 'message', 'role': 'assistant', 'model': data.get('model', 'fixture'), 'content': [], 'stop_reason': None, 'stop_sequence': None, 'usage': {'input_tokens': 1, 'output_tokens': 1}}
    if tool:
        block = {'type': 'tool_use', 'id': 'toolu_local_fixture', 'name': tool[0], 'input': {}}
        delta = {'type': 'input_json_delta', 'partial_json': json.dumps(tool[1])}
        stop_reason = 'tool_use'
        if not data.get('stream'):
            message.update(content=[{**block, 'input': tool[1]}], stop_reason=stop_reason)
            return 200, 'application/json', json.dumps(message).encode()
    else:
        block = {'type': 'text', 'text': ''}
        delta = {'type': 'text_delta', 'text': TEXT}
        stop_reason = 'end_turn'
        if not data.get('stream'):
            message.update(content=[{'type': 'text', 'text': TEXT}], stop_reason=stop_reason)
            return 200, 'application/json', json.dumps(message).encode()
    events = [('message_start', {'type': 'message_start', 'message': message}), ('content_block_start', {'type': 'content_block_start', 'index': 0, 'content_block': block}), ('content_block_delta', {'type': 'content_block_delta', 'index': 0, 'delta': delta}), ('content_block_stop', {'type': 'content_block_stop', 'index': 0}), ('message_delta', {'type': 'message_delta', 'delta': {'stop_reason': stop_reason, 'stop_sequence': None}, 'usage': {'output_tokens': 1}}), ('message_stop', {'type': 'message_stop'})]
    return 200, 'text/event-stream', ''.join('event: ' + name + '\ndata: ' + json.dumps(event) + '\n\n' for name, event in events).encode()


def claude_command(claude, scenario, settings, session, canary):
    command = [str(claude), '--print', '--no-session-persistence', '--disable-slash-commands', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', '', '--settings', str(settings)]
    if scenario == 'permission':
        # A non-bypass mode: Write needs approval and the harness never grants it.
        command += ['--permission-mode', 'default', '--tools', PERMISSION_TOOL]
    elif scenario == 'subagent':
        command += ['--tools', ','.join(SUBAGENT_TOOLS)]
    else:
        command += ['--tools', '']
    return command + ['--model', 'claude-sonnet-4-5', '--session-id', session, canary]


def split_events(events):
    """Return (ready, start, terminals, root_events, child_events) from (seq, event) pairs."""
    def pick(source, scope='root'):
        return [(seq, e) for seq, e in events if e.get('sourceEvent') in source and e.get('scope') == scope]
    root = [(seq, e) for seq, e in events if e.get('scope') == 'root']
    child = [(seq, e) for seq, e in events if e.get('scope') == 'child']
    return pick(['SessionStart']), pick(['UserPromptSubmit']), pick(TERMINALS), root, child


def evaluate(scenario, events, canary, result_code=None, stdout=None, side_effect_absent=True, unrelated_ran=True, requests=()):
    """Raise ValueError(code) on the first failed acceptance check; return the checks dict."""
    def require(condition, code):
        if not condition:
            raise ValueError(code)
    terminal = 'StopFailure' if scenario == 'provider-error' else 'Stop'
    ready, start, stop, root, child = split_events(events)
    require(len(start) == len(stop) == len(ready) == 1, 'expected_single_start_terminal_session_ready')
    require(stop[0][1]['sourceEvent'] == terminal, 'unexpected_terminal')
    require(ready[0][0] < start[0][0] < stop[0][0], 'lifecycle_out_of_order')
    require(start[0][1].get('type') == 'agent.started' and stop[0][1].get('type') == 'agent.turn_completed', 'normalized_type_mismatch')
    require(ready[0][1].get('type') == 'agent.activity' and ready[0][1].get('activityKind') == 'session_ready', 'session_ready_type_mismatch')
    require(bool(start[0][1].get('turnId')) and start[0][1]['turnId'] == stop[0][1].get('turnId'), 'turn_identity_absent_or_changed')
    require(canary not in json.dumps(events), 'private_prompt_in_journal')
    require(all(e.get('scope') in ('root', 'child') for _, e in events), 'unexpected_scope')
    require(unrelated_ran, 'unrelated_hook_not_executed')
    require('/v1/messages' in requests and 'unexpected-path' not in requests, 'local_provider_request_missing_or_unexpected')
    checks = {'correlatedTerminal': True, 'orderedLifecycle': True, 'normalizedTypes': True, 'privatePromptAbsent': True, 'unrelatedHookExecuted': True, 'loopbackProviderObserved': True}
    turn = start[0][1]['turnId']
    if scenario in ('success', 'provider-error', 'session-end'):
        require(not child, 'unexpected_scope')
    if scenario == 'success':
        require(result_code == 0 and (stdout or '').strip() == TEXT, 'cli_success_response_mismatch')
        require(stop[0][1].get('endReason') is None, 'success_terminal_reason_mismatch')
    elif scenario == 'provider-error':
        require(result_code != 0, 'provider_error_cli_exited_zero')
        require(stop[0][1].get('endReason') == 'provider_error', 'provider_error_terminal_reason_mismatch')
    elif scenario == 'permission':
        require(not child, 'unexpected_scope')
        attention = [(seq, e) for seq, e in events if e.get('type') == 'agent.needs_attention']
        require(bool(attention), 'permission_attention_not_journaled')
        require(any(e.get('attentionKind') == 'permission' and e.get('sourceEvent') in ('PermissionRequest', 'Notification') for _, e in attention), 'permission_attention_kind_or_source_mismatch')
        require(all(e.get('scope') == 'root' for _, e in attention), 'attention_scope_mismatch')
        require(all(start[0][0] < seq < stop[0][0] for seq, _ in attention), 'attention_outside_turn')
        require(all(e.get('turnId') in (None, turn) for _, e in attention), 'attention_turn_mismatch')
        require(side_effect_absent, 'permission_was_granted_or_tool_operated')
        require(stop[0][1].get('endReason') is None, 'permission_terminal_reason_mismatch')
        checks.update(permissionAttentionJournaled=True, permissionNeverApproved=True)
    elif scenario == 'subagent':
        children = [(seq, e) for seq, e in child if e.get('sourceEvent') == 'SubagentStop']
        require(not any(e.get('sourceEvent') == 'SubagentStop' for _, e in root), 'subagent_stop_scoped_root')
        require(bool(children), 'subagent_stop_not_journaled')
        require(all(e.get('type') == 'agent.turn_completed' for _, e in children), 'subagent_type_mismatch')
        require(all(e.get('type') not in ('agent.started', 'agent.session_ended') for _, e in child), 'child_event_has_root_semantics')
        require(all(seq < stop[0][0] for seq, _ in children), 'child_stop_after_root_terminal')
        require(len([1 for _, e in root if e.get('type') == 'agent.turn_completed']) == 1, 'root_terminal_count_changed')
        require(all(e.get('turnId') in (None, turn) for _, e in child), 'child_turn_mismatch')
        checks.update(childEventsScopedChild=True, rootPairUnaffectedByChild=True)
    elif scenario == 'session-end':
        ended = [(seq, e) for seq, e in events if e.get('sourceEvent') == 'SessionEnd']
        require(len(ended) == 1, 'expected_single_session_end')
        require(ended[0][1].get('type') == 'agent.session_ended' and ended[0][1].get('scope') == 'root', 'session_end_type_or_scope_mismatch')
        require(ended[0][0] > stop[0][0], 'session_end_before_terminal')
        checks.update(sessionEndAfterTerminal=True)
    return checks


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--claude', type=Path, required=True)
    parser.add_argument('--bridge', type=Path, required=True)
    parser.add_argument('--data-dir', type=Path, required=True, help='Running isolated Clawdle test profile')
    parser.add_argument('--fixture', type=Path, required=True, help='New direct .local/native-smoke* directory')
    parser.add_argument('--scenario', choices=SCENARIOS, default='success')
    args = parser.parse_args(argv)
    local = Path(__file__).resolve().parent.parent / '.local'
    for path in [args.claude, args.bridge, args.data_dir, args.fixture]:
        if not path.is_absolute() or any(part.is_symlink() or part.is_junction() for part in [path, *path.parents]):
            parser.error('Explicit absolute paths without reparse-point ancestors are required')
    for path in [args.data_dir, args.fixture]:
        if path.parent != local or not path.name.startswith('native-smoke'):
            parser.error('Profiles must be direct repository .local/native-smoke* paths')
    if args.fixture.exists():
        parser.error('Use a new fixture directory; prior evidence is preserved')
    if not args.claude.is_file() or not args.bridge.is_file() or not (args.data_dir / 'endpoint.json').is_file():
        parser.error('Select existing executables and a running isolated app profile')
    return args


class SmokeFailure(Exception):
    pass


def require(condition, code):
    if not condition:
        raise SmokeFailure(code)


def main(argv=None):
    args = parse_args(argv)
    args.fixture.mkdir()
    project = args.fixture / 'project'
    (project / '.claude').mkdir(parents=True)
    marker = args.fixture / 'unrelated-hook-ran.txt'
    unrelated = {'type': 'command', 'command': sys.executable, 'args': ['-c', 'from pathlib import Path; Path(' + repr(str(marker)) + ').write_text("preserved", encoding="utf-8")']}
    initial = {'env': {'CLAWDLE_FIXTURE_UNRELATED': 'preserved'}, 'hooks': {'SessionStart': [{'hooks': [unrelated]}]}}
    settings = project / '.claude/settings.local.json'
    settings.write_text(json.dumps(initial), encoding='utf-8')
    user_settings = Path.home() / '.claude/settings.json'

    def user_digest():
        return hashlib.sha256(user_settings.read_bytes()).hexdigest() if user_settings.exists() else None
    before = user_digest()
    env = os.environ.copy()
    for key in list(env):
        if key.startswith(('ANTHROPIC_', 'CLAUDE_CODE_USE_', 'AWS_', 'GOOGLE_')):
            env.pop(key, None)
    env.update(CLAUDE_CONFIG_DIR=str(args.fixture / 'config'), CLAWDLE_TEST_MODE='1', CLAWDLE_DATA_DIR=str(args.data_dir),
               ANTHROPIC_API_KEY='synthetic-local-fixture', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1',
               DISABLE_TELEMETRY='1', DISABLE_ERROR_REPORTING='1', API_TIMEOUT_MS='10000')
    requests = []

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *unused): pass

        def do_POST(self):
            data = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))) or b'{}')
            path = self.path.split('?')[0]
            requests.append(path if path in ['/v1/messages', '/v1/messages/count_tokens'] else 'unexpected-path')
            status, kind, body = provider_response(args.scenario, data, project, 'count_tokens' in path)
            self.send_response(status)
            self.send_header('Content-Type', kind)
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    env['ANTHROPIC_BASE_URL'] = 'http://127.0.0.1:' + str(server.server_port)
    session = str(uuid.uuid4())
    canary = 'SYNTHETIC_PRIVATE_PROMPT_' + uuid.uuid4().hex
    install = [str(args.bridge), 'install', 'claude', '--scope', 'project', '--project', str(project)]
    uninstall = [str(args.bridge), 'uninstall', 'claude', '--scope', 'project', '--project', str(project)]

    def run(command, timeout=10, **kwargs):
        # Never persist exception text: TimeoutExpired/CalledProcessError include argv (the canary).
        return subprocess.run(command, env=env, capture_output=True, timeout=timeout, **kwargs)

    report = {
        'format': 'clawdle-real-cli-smoke-v1', 'scenario': args.scenario, 'passed': False,
        'checks': {}, 'cleanup': {}, 'failures': [],
        'limitations': ['Real Claude CLI with a synthetic loopback provider, not a hosted model or account test.', LIMITATIONS[args.scenario]],
    }
    stage = 'install'
    try:
        installed = run(install)
        require(installed.returncode == 0, 'install_nonzero')
        stage = 'cli'
        result = run(claude_command(args.claude, args.scenario, settings, session, canary), timeout=45, cwd=project, text=True)
        report['cliExitCode'] = result.returncode
        stage = 'journal'
        deadline = time.monotonic() + 5
        while True:
            with sqlite3.connect((args.data_dir / 'clawdle.sqlite').as_uri() + '?mode=ro', uri=True, timeout=1) as con:
                rows = [(seq, json.loads(payload)) for seq, payload in con.execute("SELECT seq,payload FROM event_journal WHERE kind='agent' ORDER BY seq")]
            events = [(seq, event) for seq, event in rows if event.get('sessionId') == session]
            if any(event.get('sourceEvent') == AWAITED[args.scenario] for _, event in events) or time.monotonic() >= deadline:
                break
            time.sleep(.1)
        stage = 'acceptance'
        try:
            report['checks'] = evaluate(args.scenario, events, canary, result.returncode, result.stdout, not (project / PERMISSION_TARGET).exists(), marker.exists() and marker.read_text(encoding='utf-8') == 'preserved', requests)
        except ValueError as failure:
            raise SmokeFailure(str(failure))
        report['events'] = [{'seq': seq, 'sourceEvent': event['sourceEvent'], 'scope': event['scope'], 'type': event.get('type'), 'turnIdentityPresent': bool(event.get('turnId'))} for seq, event in events]
        report['providerPaths'] = list(requests)
        stage = 'binary_metadata'
        version = run([str(args.claude), '--version'], text=True)
        require(version.returncode == 0 and re.fullmatch(r'\d+\.\d+\.\d+(?: \(Claude Code\))?', version.stdout.strip()), 'claude_version_invalid')
        report['claudeVersion'] = version.stdout.strip()
        report['bridgeSha256'] = hashlib.sha256(args.bridge.read_bytes()).hexdigest()
    except BaseException as failure:
        report['failures'].append({'stage': stage, 'code': str(failure) if isinstance(failure, SmokeFailure) else type(failure).__name__})
        # Keep what was observed so a failed run still shows which events fired (sanitized: no ids or payloads).
        if 'events' not in report and 'events' in locals():
            report['observedEvents'] = [{'seq': seq, 'sourceEvent': event.get('sourceEvent'), 'scope': event.get('scope'), 'type': event.get('type')} for seq, event in events]
    finally:
        # Cleanup checks are independent, so one failure cannot hide another or the primary failure.
        try:
            server.shutdown()
            server.server_close()
            report['cleanup']['providerStopped'] = True
        except BaseException as failure:
            report['failures'].append({'stage': 'provider_cleanup', 'code': type(failure).__name__})
        try:
            removed = run(uninstall)
            require(removed.returncode == 0, 'uninstall_nonzero')
            report['cleanup']['ownedHooksRemoved'] = True
        except BaseException as failure:
            report['failures'].append({'stage': 'uninstall', 'code': str(failure) if isinstance(failure, SmokeFailure) else type(failure).__name__})
        try:
            restored = json.loads(settings.read_text(encoding='utf-8'))
            # The bridge intentionally leaves empty event arrays after removing its handlers.
            # Allow only newly added empty hook keys; every original field must match exactly.
            hooks = restored.get('hooks', {})
            require(isinstance(hooks, dict), 'restored_hooks_invalid')
            normalized = dict(restored)
            normalized['hooks'] = {key: value for key, value in hooks.items() if key in initial['hooks'] or value != []}
            require(normalized == initial, 'unrelated_settings_changed_or_handlers_remain')
            report['cleanup']['unrelatedSettingsPreservedAfterRemoval'] = True
        except BaseException as failure:
            report['failures'].append({'stage': 'settings_preservation', 'code': str(failure) if isinstance(failure, SmokeFailure) else type(failure).__name__})
        try:
            require(user_digest() == before, 'user_settings_changed')
            report['cleanup']['userSettingsUnchanged'] = True
        except BaseException as failure:
            report['failures'].append({'stage': 'user_settings_preservation', 'code': str(failure) if isinstance(failure, SmokeFailure) else type(failure).__name__})

    report['passed'] = not report['failures']
    destination = args.fixture / 'result.json'
    destination.write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(destination)
    return 0 if report['passed'] else 1


if __name__ == '__main__':
    sys.exit(main())
