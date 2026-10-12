use serde_json::Value;
pub fn validate(v: &Value) -> Result<(), String> {
    let o = v.as_object().ok_or("command_object")?;
    let kind = o
        .get("type")
        .and_then(Value::as_str)
        .ok_or("command_type")?;
    let extra: &[&str] = match kind {
        "startDaily" | "startEndless" | "giveUp" | "leaveRace" | "startSpeedrun" | "skipWord"
        | "tick" | "interruptTiming" => &[],
        "resumeGame" => {
            if !v["gameId"]
                .as_str()
                .is_some_and(|s| !s.is_empty() && s.len() <= 256)
            {
                return Err("command_game".into());
            }
            &["gameId"]
        }
        "submitGuess" => {
            if !v["word"].as_str().is_some_and(|s| s.len() <= 64) {
                return Err("command_word".into());
            }
            &["word"]
        }
        "presentRace" => {
            if !v["raceId"]
                .as_str()
                .is_some_and(|s| !s.is_empty() && s.len() <= 256)
                || v.get("lateJoin").is_some_and(|v| !v.is_boolean())
            {
                return Err("command_race".into());
            }
            &["raceId", "lateJoin"]
        }
        "changeSettings" => {
            let s = v["settings"].as_object().ok_or("command_settings")?;
            if s.iter().any(|(k, v)| {
                ![
                    "autoRace",
                    "sound",
                    "highContrast",
                    "reducedMotion",
                    "speedrunEnabled",
                    "alwaysOnTop",
                ]
                .contains(&k.as_str())
                    || !v.is_boolean()
            }) {
                return Err("command_settings".into());
            }
            &["settings"]
        }
        "resetStatistics" | "resetAll" => {
            if v["confirmed"] != true {
                return Err("command_confirmation".into());
            }
            &["confirmed"]
        }
        _ => return Err("unknown_command".into()),
    };
    if o.keys()
        .any(|k| k != "type" && k != "randomUnit" && !extra.contains(&k.as_str()))
    {
        return Err("command_field".into());
    }
    if v.get("randomUnit")
        .is_some_and(|n| !n.as_f64().is_some_and(|n| (0.0..1.0).contains(&n)))
    {
        return Err("command_random".into());
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn accepts_every_application_command_variant() {
        for kind in [
            "startDaily",
            "startEndless",
            "giveUp",
            "leaveRace",
            "startSpeedrun",
            "skipWord",
            "tick",
            "interruptTiming",
        ] {
            assert!(validate(&json!({"type":kind})).is_ok(), "{kind}");
        }
        for command in [
            json!({"type":"resumeGame","gameId":"saved-game"}),
            json!({"type":"submitGuess","word":"APPLE"}),
            json!({"type":"presentRace","raceId":"race","lateJoin":true}),
            json!({"type":"changeSettings","settings":{"autoRace":true,"sound":false,"highContrast":true,"reducedMotion":true,"speedrunEnabled":true,"alwaysOnTop":false}}),
            json!({"type":"resetStatistics","confirmed":true}),
            json!({"type":"resetAll","confirmed":true}),
        ] {
            assert!(validate(&command).is_ok(), "{command}");
        }
    }
    #[test]
    fn rejects_invalid_resume_identifiers_and_extra_fields() {
        for id in [Value::Null, json!(""), json!("x".repeat(257)), json!(12)] {
            assert!(validate(&json!({"type":"resumeGame","gameId":id})).is_err());
        }
        assert!(
            validate(&json!({"type":"resumeGame","gameId":"saved-game","path":"private"})).is_err()
        );
        assert!(validate(&json!({"type":"resumeGame","gameId":"x".repeat(256)})).is_ok());
    }
    #[test]
    fn validates_known_commands_without_arbitrary_privileged_payload() {
        assert!(validate(&json!({"type":"submitGuess","word":"APPLE","randomUnit":0.2})).is_ok());
        assert!(validate(&json!({"type":"shell","command":"evil"})).is_err());
        assert!(validate(&json!({"type":"submitGuess","word":"APPLE","prompt":"secret"})).is_err());
        assert!(validate(&json!({"type":"changeSettings","settings":{"token":"secret"}})).is_err());
        assert!(validate(&json!({"type":"resetAll","confirmed":false})).is_err());
    }
}
