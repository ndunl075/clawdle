//! Explicit integration lifecycle preferences, separate from gameplay state.
use crate::private;
use serde_json::{json, Value};
use std::{fs, path::Path};
pub fn read_config(dir: &Path) -> std::io::Result<Value> {
    let path = dir.join("bridge.json");
    private::reject_links(&path)?;
    match fs::read(path) {
        Ok(bytes) => {
            if bytes.len() > 8192 {
                return Err(std::io::Error::other("bridge_config_size"));
            }
            let value: Value = serde_json::from_slice(&bytes)?;
            if !value.is_object() {
                return Err(std::io::Error::other("bridge_config_object"));
            }
            Ok(value)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
        Err(e) => Err(e),
    }
}
pub fn update_config(dir: &Path, patch: Value) -> std::io::Result<()> {
    let mut config = read_config(dir)?;
    for (key, value) in patch
        .as_object()
        .ok_or_else(|| std::io::Error::other("bridge_config_patch"))?
    {
        config[key] = value.clone();
    }
    private::atomic_write(&dir.join("bridge.json"), &serde_json::to_vec(&config)?)
}
pub fn background_enabled(dir: &Path) -> bool {
    read_config(dir).is_ok_and(|v| v["backgroundIntegration"] == true)
}
pub fn set_background(dir: &Path, enabled: bool) -> std::io::Result<()> {
    update_config(dir, json!({"backgroundIntegration":enabled}))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn standalone_exits_and_integration_is_explicit() {
        let d = tempfile::tempdir().unwrap();
        assert!(!background_enabled(d.path()));
        update_config(
            d.path(),
            json!({"autoLaunch":true,"desktopPath":"synthetic.exe"}),
        )
        .unwrap();
        assert!(!background_enabled(d.path()));
        set_background(d.path(), true).unwrap();
        assert!(background_enabled(d.path()));
        update_config(d.path(), json!({"autoLaunch":false})).unwrap();
        assert!(background_enabled(d.path()));
        assert_eq!(
            read_config(d.path()).unwrap()["desktopPath"],
            "synthetic.exe"
        );
        set_background(d.path(), false).unwrap();
        assert!(!background_enabled(d.path()));
    }
}
