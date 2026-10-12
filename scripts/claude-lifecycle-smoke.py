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

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--claude', type=Path, required=True)
parser.add_argument('--bridge', type=Path, required=True)
parser.add_argument('--data-dir', type=Path, required=True, help='Running isolated Clawdle test profile')
parser.add_argument('--fixture', type=Path, required=True, help='New direct .local/native-smoke* directory')
parser.add_argument('--scenario', choices=['success', 'provider-error'], default='success')
args = parser.parse_args()
repo = Path(__file__).resolve().parent.parent
local = repo / '.local'
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
        status, kind = 200, 'application/json'
        if 'count_tokens' in path:
            body = json.dumps({'input_tokens': 1}).encode()
        elif args.scenario == 'provider-error':
            status = 400
            body = json.dumps({'type': 'error', 'error': {'type': 'invalid_request_error', 'message': 'Synthetic local provider failure'}}).encode()
        else:
            message = {'id': 'msg_local_fixture', 'type': 'message', 'role': 'assistant', 'model': data.get('model', 'fixture'), 'content': [], 'stop_reason': None, 'stop_sequence': None, 'usage': {'input_tokens': 1, 'output_tokens': 1}}
            text = 'Synthetic local compatibility fixture.'
            if data.get('stream'):
                events = [('message_start', {'type': 'message_start', 'message': message}), ('content_block_start', {'type': 'content_block_start', 'index': 0, 'content_block': {'type': 'text', 'text': ''}}), ('content_block_delta', {'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'text_delta', 'text': text}}), ('content_block_stop', {'type': 'content_block_stop', 'index': 0}), ('message_delta', {'type': 'message_delta', 'delta': {'stop_reason': 'end_turn', 'stop_sequence': None}, 'usage': {'output_tokens': 1}}), ('message_stop', {'type': 'message_stop'})]
                body = ''.join('event: ' + name + '\ndata: ' + json.dumps(event) + '\n\n' for name, event in events).encode()
                kind = 'text/event-stream'
            else:
                message.update(content=[{'type': 'text', 'text': text}], stop_reason='end_turn')
                body = json.dumps(message).encode()
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
class SmokeFailure(Exception):
    pass

def require(condition, code):
    if not condition:
        raise SmokeFailure(code)

def run(command, timeout=10, **kwargs):
    # Never persist exception text: TimeoutExpired/CalledProcessError include argv (the canary).
    return subprocess.run(command, env=env, capture_output=True, timeout=timeout, **kwargs)

report = {
    'format': 'clawdle-real-cli-smoke-v1', 'scenario': args.scenario, 'passed': False,
    'checks': {}, 'cleanup': {}, 'failures': [],
    'limitations': [
        'Real Claude CLI with a synthetic loopback provider, not a hosted model or account test.',
        'No permission, subagent, interactive-session shutdown, focus, or sleep claim.',
    ],
}
stage = 'install'
try:
    installed = run(install)
    require(installed.returncode == 0, 'install_nonzero')
    stage = 'cli'
    command = [str(args.claude), '--print', '--no-session-persistence', '--disable-slash-commands', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', '', '--settings', str(settings), '--tools', '', '--model', 'claude-sonnet-4-5', '--session-id', session, canary]
    result = run(command, timeout=45, cwd=project, text=True)
    report['cliExitCode'] = result.returncode
    stage = 'journal'
    deadline = time.monotonic() + 5
    terminal = 'Stop' if args.scenario == 'success' else 'StopFailure'
    while True:
        with sqlite3.connect((args.data_dir / 'clawdle.sqlite').as_uri() + '?mode=ro', uri=True, timeout=1) as con:
            rows = [(seq, json.loads(payload)) for seq, payload in con.execute("SELECT seq,payload FROM event_journal WHERE kind='agent' ORDER BY seq")]
        events = [(seq, event) for seq, event in rows if event.get('sessionId') == session]
        if any(event.get('sourceEvent') == terminal for _, event in events) or time.monotonic() >= deadline:
            break
        time.sleep(.1)
    start = [(seq, event) for seq, event in events if event.get('sourceEvent') == 'UserPromptSubmit']
    stop = [(seq, event) for seq, event in events if event.get('sourceEvent') in ['Stop', 'StopFailure']]
    ready = [(seq, event) for seq, event in events if event.get('sourceEvent') == 'SessionStart']
    stage = 'acceptance'
    require(len(start) == len(stop) == len(ready) == 1, 'expected_single_start_terminal_session_ready')
    require(stop[0][1]['sourceEvent'] == terminal, 'unexpected_terminal')
    require(ready[0][0] < start[0][0] < stop[0][0], 'lifecycle_out_of_order')
    require(start[0][1].get('type') == 'agent.started' and stop[0][1].get('type') == 'agent.turn_completed', 'normalized_type_mismatch')
    require(ready[0][1].get('type') == 'agent.activity' and ready[0][1].get('activityKind') == 'session_ready', 'session_ready_type_mismatch')
    require(bool(start[0][1].get('turnId')) and start[0][1]['turnId'] == stop[0][1].get('turnId'), 'turn_identity_absent_or_changed')
    require(canary not in json.dumps(events), 'private_prompt_in_journal')
    require(marker.read_text(encoding='utf-8') == 'preserved', 'unrelated_hook_not_executed')
    require(all(event.get('scope') == 'root' for _, event in events), 'unexpected_scope')
    require('/v1/messages' in requests and 'unexpected-path' not in requests, 'local_provider_request_missing_or_unexpected')
    if args.scenario == 'success':
        require(result.returncode == 0 and result.stdout.strip() == 'Synthetic local compatibility fixture.', 'cli_success_response_mismatch')
        require(stop[0][1].get('endReason') is None, 'success_terminal_reason_mismatch')
    else:
        require(result.returncode != 0, 'provider_error_cli_exited_zero')
        require(stop[0][1].get('endReason') == 'provider_error', 'provider_error_terminal_reason_mismatch')
    report['checks'] = {'correlatedTerminal': True, 'orderedLifecycle': True, 'normalizedTypes': True, 'privatePromptAbsent': True, 'unrelatedHookExecuted': True, 'loopbackProviderObserved': True}
    report['events'] = [{'seq': seq, 'sourceEvent': event['sourceEvent'], 'scope': event['scope'], 'turnIdentityPresent': bool(event.get('turnId'))} for seq, event in events]
    report['providerPaths'] = list(requests)
    stage = 'binary_metadata'
    version = run([str(args.claude), '--version'], text=True)
    require(version.returncode == 0 and re.fullmatch(r'\d+\.\d+\.\d+(?: \(Claude Code\))?', version.stdout.strip()), 'claude_version_invalid')
    report['claudeVersion'] = version.stdout.strip()
    report['bridgeSha256'] = hashlib.sha256(args.bridge.read_bytes()).hexdigest()
except BaseException as failure:
    report['failures'].append({'stage': stage, 'code': str(failure) if isinstance(failure, SmokeFailure) else type(failure).__name__})
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
sys.exit(0 if report['passed'] else 1)
