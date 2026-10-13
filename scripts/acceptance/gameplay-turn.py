"""One real Claude Code turn against a loopback synthetic provider whose reply the caller can hold.

Used by gameplay.mjs to control race ordering. Never calls a hosted model: the provider is a
127.0.0.1 server and ANTHROPIC_BASE_URL points at it. The provider withholds the gating response
until --release-file exists, so the caller decides when the turn can finish.

Reuses the pure provider/command helpers of scripts/claude-lifecycle-smoke.py (loaded by path).
"""
import argparse
import hashlib
import http.server
import importlib.util
import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('lifecycle_smoke', HERE.parent / 'claude-lifecycle-smoke.py')
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--claude', type=Path, required=True)
    p.add_argument('--bridge', type=Path, required=True)
    p.add_argument('--data-dir', type=Path, required=True)
    p.add_argument('--fixture', type=Path, required=True, help='New directory for this turn')
    p.add_argument('--session-id', required=True)
    p.add_argument('--scenario', choices=['success', 'provider-error', 'subagent'], default='success')
    p.add_argument('--release-file', type=Path, help='Hold the gating provider response until this file exists')
    p.add_argument('--hold-max', type=float, default=100)
    args = p.parse_args()
    if args.fixture.exists():
        p.error('Use a new fixture directory')
    project = args.fixture / 'project'
    (project / '.claude').mkdir(parents=True)
    settings = project / '.claude/settings.local.json'
    settings.write_text('{}', encoding='utf-8')
    user_settings = Path.home() / '.claude/settings.json'
    digest = lambda: hashlib.sha256(user_settings.read_bytes()).hexdigest() if user_settings.exists() else None
    before = digest()
    env = os.environ.copy()
    for key in list(env):
        if key.startswith(('ANTHROPIC_', 'CLAUDE_CODE_USE_', 'AWS_', 'GOOGLE_')):
            env.pop(key, None)
    env.update(CLAUDE_CONFIG_DIR=str(args.fixture / 'config'), CLAWDLE_TEST_MODE='1', CLAWDLE_DATA_DIR=str(args.data_dir),
               ANTHROPIC_API_KEY='synthetic-local-fixture', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1',
               DISABLE_TELEMETRY='1', DISABLE_ERROR_REPORTING='1', API_TIMEOUT_MS=str(int((args.hold_max + 20) * 1000)))
    log = {'sessionId': args.session_id, 'scenario': args.scenario, 'requests': [], 'held': 0}

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *unused): pass

        def do_POST(self):
            data = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))) or b'{}')
            path = self.path.split('?')[0]
            counting = 'count_tokens' in path
            log['requests'].append(path if path in ['/v1/messages', '/v1/messages/count_tokens'] else 'unexpected-path')
            if not counting and args.release_file and not smoke.is_child_request(data):
                # Subagent scenario: gate the root's final reply (after the child finished); others gate the first reply.
                gate = smoke.has_tool_result(data) if args.scenario == 'subagent' else True
                if gate:
                    log['held'] += 1
                    deadline = time.monotonic() + args.hold_max
                    while not args.release_file.exists() and time.monotonic() < deadline:
                        time.sleep(0.05)
            status, kind, body = smoke.provider_response(args.scenario, data, project, counting)
            try:
                self.send_response(status)
                self.send_header('Content-Type', kind)
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            except OSError:
                pass

    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    env['ANTHROPIC_BASE_URL'] = 'http://127.0.0.1:' + str(server.server_port)
    run = lambda command, timeout=15, **kw: subprocess.run(command, env=env, capture_output=True, timeout=timeout, **kw)
    install = [str(args.bridge), 'install', 'claude', '--scope', 'project', '--project', str(project)]
    uninstall = [str(args.bridge), 'uninstall', 'claude', '--scope', 'project', '--project', str(project)]
    log['failures'] = []
    try:
        if run(install).returncode != 0:
            raise RuntimeError('install_nonzero')
        started = time.monotonic()
        result = run(smoke.claude_command(args.claude, args.scenario, settings, args.session_id, 'gameplay acceptance prompt'),
                     timeout=args.hold_max + 60, cwd=project, text=True)
        log.update(exitCode=result.returncode, stdoutMatches=(result.stdout or '').strip() == smoke.TEXT, seconds=round(time.monotonic() - started, 2))
    except BaseException as failure:
        log['failures'].append(type(failure).__name__ + ':' + str(failure)[:80])
    finally:
        server.shutdown()
        server.server_close()
        try:
            if run(uninstall).returncode != 0:
                log['failures'].append('uninstall_nonzero')
        except BaseException as failure:
            log['failures'].append('uninstall:' + type(failure).__name__)
        log['userSettingsUnchanged'] = digest() == before
        log['hostedModelCalled'] = False
        log['providerPorts'] = 'loopback only'
        (args.fixture / 'turn.json').write_text(json.dumps(log, indent=2), encoding='utf-8')
    print(args.fixture / 'turn.json')
    return 0 if not log['failures'] else 1


if __name__ == '__main__':
    sys.exit(main())
