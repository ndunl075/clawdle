//! Optimistic, ownership-based configuration edits. Backups are never restored over user changes.
use crate::private::{atomic_write, reject_links};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
};
type Result<T> = std::result::Result<T, String>;
#[derive(Clone, Serialize, Deserialize, Default)]
struct Manifest {
    handlers: Vec<Owned>,
}
#[derive(Clone, Serialize, Deserialize)]
struct Owned {
    event: String,
    handler: Value,
    hash: String,
}
fn hash(v: &Value) -> String {
    format!("{:x}", Sha256::digest(v.to_string().as_bytes()))
}
pub fn settings_path(scope: &str, project: Option<&Path>) -> Result<PathBuf> {
    match scope {
        "user" => directories::BaseDirs::new()
            .map(|d| d.home_dir().join(".claude/settings.json"))
            .ok_or("home_unavailable".into()),
        "project" => project
            .filter(|p| p.is_absolute())
            .map(|p| p.join(".claude/settings.local.json"))
            .ok_or("absolute_project_required".into()),
        _ => Err("invalid_scope".into()),
    }
}
fn read(path: &Path) -> Result<(Vec<u8>, Value)> {
    reject_links(path).map_err(|_| "unsafe_settings_path")?;
    let bytes = match fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => b"{}".to_vec(),
        Err(_) => return Err("settings_read".into()),
    };
    if bytes.len() > 4 * 1024 * 1024 {
        return Err("settings_oversized".into());
    }
    let v: Value =
        serde_json::from_slice(&bytes).map_err(|_| "settings_invalid_json_use_manual_setup")?;
    if !v.is_object() {
        return Err("settings_not_object".into());
    }
    Ok((bytes, v))
}
pub struct Prepared {
    path: PathBuf,
    original: Vec<u8>,
    replacement: Value,
    manifest_path: PathBuf,
    manifest: Manifest,
    recovery_manifest: Manifest,
}
impl Prepared {
    pub fn commit(self) -> Result<()> {
        reject_links(&self.path).map_err(|_| "unsafe_settings_path")?;
        let current = fs::read(&self.path).unwrap_or_else(|_| b"{}".to_vec());
        if current != self.original {
            return Err("settings_changed_retry".into());
        }
        let parent = self.path.parent().ok_or("settings_parent")?;
        reject_links(parent).map_err(|_| "unsafe_settings_path")?;
        fs::create_dir_all(parent).map_err(|_| "settings_directory")?;
        let lock = self.path.with_extension("clawdle-lock");
        let _guard = Lock::new(lock)?;
        if fs::read(&self.path).unwrap_or_else(|_| b"{}".to_vec()) != self.original {
            return Err("settings_changed_retry".into());
        }
        if self.path.exists() {
            let backup = self
                .path
                .with_extension(format!("clawdle-backup-{}.json", uuid::Uuid::new_v4()));
            atomic_write(&backup, &self.original).map_err(|_| "settings_backup")?;
        }
        // Persist recovery ownership before settings. A failed settings write leaves harmless receipts.
        atomic_write(
            &self.manifest_path,
            &serde_json::to_vec_pretty(&self.recovery_manifest).map_err(|_| "manifest_json")?,
        )
        .map_err(|_| "manifest_write")?;
        if fs::read(&self.path).unwrap_or_else(|_| b"{}".to_vec()) != self.original {
            return Err("settings_changed_retry".into());
        }
        atomic_write(
            &self.path,
            &serde_json::to_vec_pretty(&self.replacement).map_err(|_| "settings_json")?,
        )
        .map_err(|_| "settings_write")?;
        atomic_write(
            &self.manifest_path,
            &serde_json::to_vec_pretty(&self.manifest).map_err(|_| "manifest_json")?,
        )
        .map_err(|_| "manifest_finalize")?;
        Ok(())
    }
}
struct Lock(PathBuf);
impl Lock {
    fn new(path: PathBuf) -> Result<Self> {
        reject_links(&path).map_err(|_| "unsafe_lock")?;
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|_| "settings_busy")?;
        Ok(Self(path))
    }
}
impl Drop for Lock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}
pub fn prepare(
    path: &Path,
    manifest_dir: &Path,
    executable: &Path,
    install: bool,
) -> Result<Prepared> {
    prepare_for(path, manifest_dir, executable, install, false)
}
pub fn prepare_for(
    path: &Path,
    manifest_dir: &Path,
    executable: &Path,
    install: bool,
    development: bool,
) -> Result<Prepared> {
    crate::private::secure_dir(manifest_dir).map_err(|_| "manifest_directory")?;
    let key = format!(
        "{:x}",
        Sha256::digest(path.as_os_str().to_string_lossy().as_bytes())
    );
    let manifest_path = manifest_dir.join(format!("claude-{key}.json"));
    reject_links(&manifest_path).map_err(|_| "unsafe_manifest")?;
    let old: Manifest = match fs::read(&manifest_path) {
        Ok(b) => serde_json::from_slice(&b).map_err(|_| "invalid_manifest")?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Manifest::default(),
        Err(_) => return Err("manifest_read".into()),
    };
    let (original, mut replacement) = read(path)?;
    let object = replacement.as_object_mut().unwrap();
    if !object.contains_key("hooks") {
        object.insert("hooks".into(), json!({}));
    }
    let hooks = object
        .get_mut("hooks")
        .unwrap()
        .as_object_mut()
        .ok_or("unsupported_hooks_shape")?;
    for owned in &old.handlers {
        if hash(&owned.handler) != owned.hash {
            return Err("manifest_integrity".into());
        }
        if let Some(groups) = hooks.get_mut(&owned.event) {
            let groups = groups.as_array_mut().ok_or("unsupported_hook_groups")?;
            for group in groups.iter_mut() {
                if let Some(handlers) = group.get_mut("hooks").and_then(Value::as_array_mut) {
                    handlers.retain(|h| h != &owned.handler);
                }
            }
            groups.retain(|g| {
                g.get("hooks")
                    .and_then(Value::as_array)
                    .is_none_or(|h| !h.is_empty())
            });
        }
    }
    let mut manifest = Manifest::default();
    if install {
        if !executable.is_absolute() {
            return Err("absolute_executable_required".into());
        }
        let command = executable.to_str().ok_or("executable_unicode")?;
        for event in clawdle_agent_adapters::HOOKS {
            let mut args = vec!["hook", "--provider", "claude"];
            if development {
                args.push("--development");
            }
            let handler =
                json!({"type":"command","command":command,"args":args,"async":true,"timeout":1});
            let groups = hooks
                .entry((*event).to_owned())
                .or_insert(json!([]))
                .as_array_mut()
                .ok_or("unsupported_hook_groups")?;
            groups.push(json!({"hooks":[handler.clone()]}));
            manifest.handlers.push(Owned {
                event: (*event).into(),
                hash: hash(&handler),
                handler,
            });
        }
    }
    Ok(Prepared {
        path: path.into(),
        original,
        replacement,
        manifest_path,
        recovery_manifest: Manifest {
            handlers: old
                .handlers
                .into_iter()
                .chain(manifest.handlers.clone())
                .collect(),
        },
        manifest,
    })
}
pub fn owned_count(path: &Path, manifest_dir: &Path) -> usize {
    let key = format!(
        "{:x}",
        Sha256::digest(path.as_os_str().to_string_lossy().as_bytes())
    );
    let p = manifest_dir.join(format!("claude-{key}.json"));
    if reject_links(&p).is_err() {
        return 0;
    }
    fs::read(p)
        .ok()
        .and_then(|b| serde_json::from_slice::<Manifest>(&b).ok())
        .map(|m| m.handlers.len())
        .unwrap_or(0)
}
pub fn has_owned_handlers(manifest_dir: &Path) -> bool {
    if reject_links(manifest_dir).is_err() {
        return false;
    }
    fs::read_dir(manifest_dir).ok().is_some_and(|entries| {
        entries
            .take(256)
            .filter_map(std::result::Result::ok)
            .any(|entry| {
                let path = entry.path();
                if path.extension().and_then(|x| x.to_str()) != Some("json")
                    || reject_links(&path).is_err()
                {
                    return false;
                }
                entry
                    .metadata()
                    .ok()
                    .filter(|m| m.is_file() && m.len() <= 1024 * 1024)
                    .and_then(|_| fs::read(path).ok())
                    .and_then(|b| serde_json::from_slice::<Manifest>(&b).ok())
                    .is_some_and(|m| !m.handlers.is_empty())
            })
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[cfg(windows)]
    fn failed_uninstall_preserves_ownership_for_retry() {
        use std::os::windows::fs::OpenOptionsExt;
        let d = tempfile::tempdir().unwrap();
        let path = d.path().join("settings.json");
        let private = d.path().join("private");
        prepare(&path, &private, &exe(d.path()), true)
            .unwrap()
            .commit()
            .unwrap();
        let pending = prepare(&path, &private, &exe(d.path()), false).unwrap();
        let held = fs::OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(&path)
            .unwrap();
        assert!(pending.commit().is_err());
        drop(held);
        assert_eq!(
            owned_count(&path, &private),
            clawdle_agent_adapters::HOOKS.len()
        );
        prepare(&path, &private, &exe(d.path()), false)
            .unwrap()
            .commit()
            .unwrap();
        let v: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert!(v["hooks"]["Stop"].as_array().unwrap().is_empty());
    }
    fn exe(d: &Path) -> PathBuf {
        d.join("Unicode café's folder").join("clawdle-bridge.exe")
    }
    #[test]
    fn idempotent_preserves_unrelated_and_edited_owned() {
        let d = tempfile::tempdir().unwrap();
        let path = d.path().join("settings.json");
        let manifest = d.path().join("private");
        fs::write(&path,br#"{"theme":"dark","hooks":{"Stop":[{"hooks":[{"type":"command","command":"echo mine"}]}]}}"#).unwrap();
        for _ in 0..2 {
            prepare(&path, &manifest, &exe(d.path()), true)
                .unwrap()
                .commit()
                .unwrap();
        }
        let mut v: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(v["hooks"]["Stop"].as_array().unwrap().len(), 2);
        assert_eq!(
            v["hooks"]["Stop"][1]["hooks"][0]["command"],
            exe(d.path()).to_str().unwrap()
        );
        assert_eq!(
            v["hooks"]["Stop"][1]["hooks"][0]["args"],
            json!(["hook", "--provider", "claude"])
        );
        assert_eq!(v["hooks"]["Stop"][1]["hooks"][0]["async"], true);
        v["hooks"]["Stop"][1]["hooks"][0]["command"] = "user-edited".into();
        fs::write(&path, v.to_string()).unwrap();
        prepare(&path, &manifest, &exe(d.path()), false)
            .unwrap()
            .commit()
            .unwrap();
        let v: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(v["theme"], "dark");
        assert_eq!(v["hooks"]["Stop"].as_array().unwrap().len(), 2);
    }
    #[test]
    fn concurrent_edit_aborts() {
        let d = tempfile::tempdir().unwrap();
        let path = d.path().join("settings.json");
        let p = prepare(&path, &d.path().join("private"), &exe(d.path()), true).unwrap();
        fs::write(&path, b"{\"changed\":true}").unwrap();
        assert_eq!(p.commit().unwrap_err(), "settings_changed_retry");
        assert_eq!(fs::read(&path).unwrap(), b"{\"changed\":true}");
    }
    #[test]
    fn development_install_uses_separate_discovery() {
        let d = tempfile::tempdir().unwrap();
        let path = d.path().join("settings.json");
        prepare_for(&path, &d.path().join("private"), &exe(d.path()), true, true)
            .unwrap()
            .commit()
            .unwrap();
        let v: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(
            v["hooks"]["Stop"][0]["hooks"][0]["args"],
            json!(["hook", "--provider", "claude", "--development"])
        );
    }
    #[test]
    fn malformed_never_replaced() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("settings.json");
        fs::write(&p, b"invalid").unwrap();
        assert!(prepare(&p, &d.path().join("private"), &exe(d.path()), true).is_err());
        assert_eq!(fs::read(p).unwrap(), b"invalid");
    }
}
