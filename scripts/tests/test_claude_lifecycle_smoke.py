import importlib.util
import json
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('smoke', Path(__file__).resolve().parents[1] / 'claude-lifecycle-smoke.py')
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)

CANARY = 'CANARY'
REQUESTS = ['/v1/messages']


def ev(source, scope='root', type_='agent.activity', turn='t1', **extra):
    return {'sourceEvent': source, 'scope': scope, 'type': type_, 'turnId': turn, **extra}


def base(terminal='Stop'):
    return [
        (1, ev('SessionStart', turn=None, activityKind='session_ready')),
        (2, ev('UserPromptSubmit', type_='agent.started')),
        (10, ev(terminal, type_='agent.turn_completed', **({'endReason': 'provider_error'} if terminal == 'StopFailure' else {}))),
    ]


def check(scenario, events, **kwargs):
    defaults = dict(canary=CANARY, result_code=0, stdout=smoke.TEXT, requests=REQUESTS)
    defaults.update(kwargs)
    return smoke.evaluate(scenario, events, **defaults)


def fails(test, scenario, events, code, **kwargs):
    with test.assertRaises(ValueError) as caught:
        check(scenario, events, **kwargs)
    test.assertEqual(str(caught.exception), code)


def stream(body):
    return [json.loads(line[6:]) for line in body.decode().splitlines() if line.startswith('data: ')]


def request(tools=(), text='hello', stream_=True, tool_result=False):
    content = [{'type': 'tool_result', 'tool_use_id': 'x', 'content': 'ok'}] if tool_result else [{'type': 'text', 'text': text}]
    return {'stream': stream_, 'tools': [{'name': name} for name in tools], 'messages': [{'role': 'user', 'content': content}]}


class ProviderTests(unittest.TestCase):
    def test_success_text(self):
        status, kind, body = smoke.provider_response('success', request(), '/p')
        self.assertEqual((status, kind), (200, 'text/event-stream'))
        self.assertIn(smoke.TEXT, body.decode())

    def test_provider_error(self):
        self.assertEqual(smoke.provider_response('provider-error', request(), '/p')[0], 400)

    def test_count_tokens(self):
        self.assertEqual(json.loads(smoke.provider_response('permission', {}, '/p', True)[2]), {'input_tokens': 1})

    def test_permission_requests_write_tool_then_text(self):
        events = stream(smoke.provider_response('permission', request(['Write']), '/proj')[2])
        start = events[1]['content_block']
        self.assertEqual((start['type'], start['name']), ('tool_use', 'Write'))
        self.assertEqual(events[4]['delta']['stop_reason'], 'tool_use')
        self.assertTrue(json.loads(events[2]['delta']['partial_json'])['file_path'].endswith(smoke.PERMISSION_TARGET))
        after = smoke.provider_response('permission', request(['Write'], tool_result=True), '/proj')[2]
        self.assertIn(smoke.TEXT, after.decode())

    def test_permission_without_tool_is_text(self):
        self.assertIn(smoke.TEXT, smoke.provider_response('permission', request([]), '/p')[2].decode())

    def test_non_streaming_tool_use(self):
        body = json.loads(smoke.provider_response('permission', request(['Write'], stream_=False), '/p')[2])
        self.assertEqual(body['stop_reason'], 'tool_use')
        self.assertEqual(body['content'][0]['name'], 'Write')

    def test_subagent_uses_available_tool_and_child_gets_text(self):
        for name in smoke.SUBAGENT_TOOLS:
            block = stream(smoke.provider_response('subagent', request([name]), '/p')[2])[1]['content_block']
            self.assertEqual(block['name'], name)
        tool = smoke.planned_tool_use('subagent', request(['Agent']), '/p')
        self.assertIs(tool[1]['run_in_background'], False)
        child = request(['Agent'], text=smoke.CHILD_MARKER)
        self.assertIn(smoke.TEXT, smoke.provider_response('subagent', child, '/p')[2].decode())
        done = request(['Agent'], tool_result=True)
        self.assertIn(smoke.TEXT, smoke.provider_response('subagent', done, '/p')[2].decode())

    def test_success_and_session_end_never_use_tools(self):
        for scenario in ['success', 'session-end']:
            self.assertIn(smoke.TEXT, smoke.provider_response(scenario, request(['Write', 'Agent']), '/p')[2].decode())


class CommandTests(unittest.TestCase):
    def test_never_bypasses_permissions(self):
        for scenario in smoke.SCENARIOS:
            command = smoke.claude_command('c', scenario, 's', 'id', CANARY)
            self.assertFalse(any('dangerously' in part or part == 'bypassPermissions' for part in command))
            self.assertEqual(command[-1], CANARY)
        permission = smoke.claude_command('c', 'permission', 's', 'id', CANARY)
        self.assertEqual(permission[permission.index('--permission-mode') + 1], 'default')
        self.assertEqual(permission[permission.index('--tools') + 1], 'Write')

    def test_other_scenarios_keep_no_tools(self):
        command = smoke.claude_command('c', 'success', 's', 'id', CANARY)
        self.assertEqual(command[command.index('--tools') + 1], '')


class AcceptanceTests(unittest.TestCase):
    def test_success_and_provider_error(self):
        check('success', base())
        check('provider-error', base('StopFailure'), result_code=1, stdout='')

    def test_success_failures(self):
        fails(self, 'success', base(), 'cli_success_response_mismatch', stdout='other')
        fails(self, 'success', base()[:2], 'expected_single_start_terminal_session_ready')
        fails(self, 'success', base() + [(11, ev('Stop', type_='agent.turn_completed'))], 'expected_single_start_terminal_session_ready')
        fails(self, 'success', base(), 'private_prompt_in_journal', canary='tur')
        fails(self, 'success', base(), 'unrelated_hook_not_executed', unrelated_ran=False)
        fails(self, 'success', base(), 'local_provider_request_missing_or_unexpected', requests=[])
        fails(self, 'success', base() + [(5, ev('SubagentStop', 'child', 'agent.turn_completed'))], 'unexpected_scope')
        fails(self, 'success', base() + [(5, ev('PreToolUse', None))], 'unexpected_scope')
        fails(self, 'subagent', base() + [(5, ev('SubagentStop', 'workspace', 'agent.turn_completed'))], 'unexpected_scope')

    def test_provider_error_failures(self):
        fails(self, 'provider-error', base('StopFailure'), 'provider_error_cli_exited_zero')
        events = base('StopFailure')
        events[2][1].pop('endReason')
        fails(self, 'provider-error', events, 'provider_error_terminal_reason_mismatch', result_code=1)

    def permission(self, **extra):
        attention = ev('PermissionRequest', type_='agent.needs_attention', attentionKind='permission', **extra)
        return base() + [(5, attention)]

    def test_permission_pass(self):
        checks = check('permission', self.permission())
        self.assertTrue(checks['permissionAttentionJournaled'] and checks['permissionNeverApproved'])
        check('permission', base() + [(5, ev('Notification', type_='agent.needs_attention', attentionKind='permission', turn=None))])

    def test_permission_failures(self):
        fails(self, 'permission', base(), 'permission_attention_not_journaled')
        fails(self, 'permission', self.permission(), 'permission_was_granted_or_tool_operated', side_effect_absent=False)
        fails(self, 'permission', base() + [(5, ev('Notification', type_='agent.needs_attention', attentionKind='input'))], 'permission_attention_kind_or_source_mismatch')
        late = base() + [(11, ev('PermissionRequest', type_='agent.needs_attention', attentionKind='permission'))]
        fails(self, 'permission', late, 'attention_outside_turn')
        fails(self, 'permission', self.permission(turn='other'), 'attention_turn_mismatch')
        fails(self, 'permission', base() + [(5, ev('PermissionRequest', 'child', 'agent.needs_attention', attentionKind='permission'))], 'unexpected_scope')
        fails(self, 'permission', self.permission() + [(11, ev('Stop', type_='agent.turn_completed'))], 'expected_single_start_terminal_session_ready')

    def subagent(self):
        return base() + [(5, ev('SubagentStop', 'child', 'agent.turn_completed'))]

    def test_subagent_pass(self):
        self.assertTrue(check('subagent', self.subagent())['rootPairUnaffectedByChild'])

    def test_subagent_failures(self):
        fails(self, 'subagent', base(), 'subagent_stop_not_journaled')
        late = base() + [(11, ev('SubagentStop', 'child', 'agent.turn_completed'))]
        self.assertTrue(check('subagent', late)['rootPairUnaffectedByChild'])
        started = self.subagent() + [(6, ev('UserPromptSubmit', 'child', 'agent.started'))]
        fails(self, 'subagent', started, 'child_event_has_root_semantics')
        fails(self, 'subagent', self.subagent() + [(5, ev('SubagentStop', 'root', 'agent.turn_completed'))], 'subagent_stop_scoped_root')
        fails(self, 'subagent', self.subagent() + [(7, ev('SubagentStop', 'child', 'agent.turn_completed', turn='other'))], 'child_turn_mismatch')

    def test_session_end(self):
        ended = base() + [(11, ev('SessionEnd', type_='agent.session_ended', endReason='unknown'))]
        self.assertTrue(check('session-end', ended)['sessionEndAfterTerminal'])
        fails(self, 'session-end', base(), 'expected_single_session_end')
        early = base() + [(5, ev('SessionEnd', type_='agent.session_ended'))]
        fails(self, 'session-end', early, 'session_end_before_terminal')
        wrong = base() + [(11, ev('SessionEnd', type_='agent.activity'))]
        fails(self, 'session-end', wrong, 'session_end_type_or_scope_mismatch')
        double = ended + [(12, ev('SessionEnd', type_='agent.session_ended'))]
        fails(self, 'session-end', double, 'expected_single_session_end')


if __name__ == '__main__':
    unittest.main()
