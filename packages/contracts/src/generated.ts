// Generated from versioned JSON schemas. Run pnpm contracts:generate.
export type AgentEvent = {
  "protocolVersion": 1;
  "eventId": string;
  "provider": "claude";
  "sessionId": string;
  "turnId": string | null;
  "scope": "root" | "child";
  "type": "agent.started" | "agent.activity" | "agent.needs_attention" | "agent.turn_completed" | "agent.session_ended";
  "sourceEvent": "SessionStart" | "UserPromptSubmit" | "PreToolUse" | "PostToolUse" | "PermissionRequest" | "Notification" | "Stop" | "StopFailure" | "SessionEnd" | "SubagentStop";
  "observedAtUtc": string;
  "projectKey": string | null;
  "attentionKind"?: "permission" | "input";
  "activityKind"?: "session_ready" | "tool_started" | "tool_finished";
  "endReason"?: "closed" | "interrupted" | "provider_error" | "unknown";
};
export type JournalEntry = {
  "seq": number;
  "eventId": string;
  "runtimeEpoch": string;
  "receivedAtUtc": string;
  "receivedMonoMs": number;
  "kind": "command" | "agent" | "runtime";
  "payload": unknown;
};
export type ClawdleExport = {
  "schemaVersion": 1;
  "exportedAtUtc": string;
  "games": ReadonlyArray<Record<string, unknown>>;
  "results": ReadonlyArray<Record<string, unknown>>;
  "settings"?: Record<string, unknown>;
  "races"?: ReadonlyArray<Record<string, unknown>>;
  "speedruns"?: ReadonlyArray<Record<string, unknown>>;
  "dictionaryVersion"?: string;
  "scheduleVersion"?: string;
};
