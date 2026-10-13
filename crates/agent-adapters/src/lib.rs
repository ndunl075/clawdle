//! Provider metadata only. Never reads transcripts or retains prompt/tool bodies.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

pub const HOOKS: &[&str] = &[
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PermissionRequest",
    "Notification",
    "Stop",
    "StopFailure",
    "SessionEnd",
    "SubagentStop",
];

/// Hooks that end a turn. Headless `claude --print` exits right after these fire, so they are
/// installed as synchronous handlers; an async handler can be killed before it delivers.
pub const TERMINAL_HOOKS: &[&str] = &["Stop", "StopFailure"];

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentEvent {
    pub protocol_version: u8,
    pub event_id: String,
    pub provider: String,
    pub session_id: String,
    pub turn_id: Option<String>,
    pub scope: String,
    #[serde(rename = "type")]
    pub event_type: String,
    pub source_event: String,
    pub observed_at_utc: String,
    pub project_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attention_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub activity_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_reason: Option<String>,
}

impl AgentEvent {
    pub fn validate(&self) -> Result<(), &'static str> {
        let identifier =
            |s: &str| !s.is_empty() && s.len() <= 256 && !s.chars().any(char::is_control);
        if self.protocol_version != 1
            || self.provider != "claude"
            || uuid::Uuid::parse_str(&self.event_id).is_err()
            || !identifier(&self.session_id)
            || self.turn_id.as_ref().is_some_and(|s| !identifier(s))
        {
            return Err("identity");
        }
        if !["root", "child"].contains(&self.scope.as_str())
            || !HOOKS.contains(&self.source_event.as_str())
            || ![
                "agent.started",
                "agent.activity",
                "agent.needs_attention",
                "agent.turn_completed",
                "agent.session_ended",
            ]
            .contains(&self.event_type.as_str())
        {
            return Err("event");
        }
        if chrono::DateTime::parse_from_rfc3339(&self.observed_at_utc).is_err() {
            return Err("timestamp");
        }
        if self
            .attention_kind
            .as_ref()
            .is_some_and(|s| !["permission", "input"].contains(&s.as_str()))
            || self.activity_kind.as_ref().is_some_and(|s| {
                !["session_ready", "tool_started", "tool_finished"].contains(&s.as_str())
            })
            || self.end_reason.as_ref().is_some_and(|s| {
                !["closed", "interrupted", "provider_error", "unknown"].contains(&s.as_str())
            })
        {
            return Err("enum");
        }
        if self
            .project_key
            .as_ref()
            .is_some_and(|s| s.len() != 64 || !s.bytes().all(|b| b.is_ascii_hexdigit()))
        {
            return Err("project");
        }
        Ok(())
    }
}

pub fn parse_claude(raw: &[u8], salt: &[u8]) -> Result<Option<AgentEvent>, &'static str> {
    if raw.len() > 4 * 1024 * 1024 {
        return Err("oversized");
    }
    let v: Value = serde_json::from_slice(raw).map_err(|_| "json")?;
    let event = v["hook_event_name"].as_str().ok_or("event")?;
    if !HOOKS.contains(&event) {
        return Ok(None);
    }
    let mut e = AgentEvent {
        protocol_version: 1,
        event_id: uuid::Uuid::new_v4().to_string(),
        provider: "claude".into(),
        session_id: v["session_id"].as_str().ok_or("session")?.into(),
        turn_id: v["prompt_id"].as_str().map(str::to_owned),
        scope: if event == "SubagentStop"
            || v["agent_id"].as_str().is_some()
            || v["scope"].as_str() == Some("child")
        {
            "child"
        } else {
            "root"
        }
        .into(),
        event_type: "agent.activity".into(),
        source_event: event.into(),
        observed_at_utc: chrono::Utc::now().to_rfc3339(),
        project_key: v["cwd"].as_str().map(|cwd| {
            let mut h = Sha256::new();
            h.update(salt);
            h.update(cwd.as_bytes());
            format!("{:x}", h.finalize())
        }),
        attention_kind: None,
        activity_kind: None,
        end_reason: None,
    };
    match event {
        "UserPromptSubmit" => e.event_type = "agent.started".into(),
        "SessionStart" => e.activity_kind = Some("session_ready".into()),
        "PreToolUse" => e.activity_kind = Some("tool_started".into()),
        "PostToolUse" => e.activity_kind = Some("tool_finished".into()),
        "PermissionRequest" => {
            e.event_type = "agent.needs_attention".into();
            e.attention_kind = Some("permission".into());
        }
        "Notification" => match v["notification_type"].as_str() {
            Some("permission_prompt") => {
                e.event_type = "agent.needs_attention".into();
                e.attention_kind = Some("permission".into());
            }
            Some("idle_prompt" | "elicitation_dialog") => {
                e.event_type = "agent.needs_attention".into();
                e.attention_kind = Some("input".into());
            }
            _ => return Ok(None),
        },
        "Stop" | "SubagentStop" => e.event_type = "agent.turn_completed".into(),
        "StopFailure" => {
            e.event_type = "agent.turn_completed".into();
            e.end_reason = Some("provider_error".into());
        }
        "SessionEnd" => {
            e.event_type = "agent.session_ended".into();
            e.end_reason = Some(
                match v["reason"].as_str() {
                    Some("clear" | "logout" | "prompt_input_exit") => "closed",
                    _ => "unknown",
                }
                .into(),
            );
        }
        _ => return Ok(None),
    }
    e.validate()?;
    Ok(Some(e))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn metadata_allowlist() {
        let e = parse_claude(br#"{"hook_event_name":"UserPromptSubmit","session_id":"s","prompt_id":"p","cwd":"SECRET_PATH","prompt":"SECRET_PROMPT","transcript_path":"SECRET_TRANSCRIPT","tool_input":{"password":"SECRET_PASSWORD"}}"#, b"salt").unwrap().unwrap();
        let s = serde_json::to_string(&e).unwrap();
        assert!(!s.contains("SECRET"));
        assert_eq!(e.turn_id.as_deref(), Some("p"));
    }
    #[test]
    fn child_never_root() {
        let e = parse_claude(
            br#"{"hook_event_name":"SubagentStop","session_id":"s","prompt_id":"p"}"#,
            b"",
        )
        .unwrap()
        .unwrap();
        assert_eq!(e.scope, "child");
    }
    #[test]
    fn missing_prompt_stays_missing() {
        let e = parse_claude(
            br#"{"hook_event_name":"StopFailure","session_id":"s"}"#,
            b"",
        )
        .unwrap()
        .unwrap();
        assert_eq!(e.turn_id, None);
        assert_eq!(e.end_reason.as_deref(), Some("provider_error"));
    }
    #[test]
    fn rejects_extra_wire_fields() {
        let mut v = serde_json::to_value(
            parse_claude(br#"{"hook_event_name":"Stop","session_id":"s"}"#, b"")
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        v["prompt"] = "secret".into();
        assert!(serde_json::from_value::<AgentEvent>(v).is_err());
    }
}
