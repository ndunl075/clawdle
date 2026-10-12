//! User-selected native Save As; the renderer cannot supply a filesystem path.
use std::path::PathBuf;
const MAX_EXPORT_BYTES: usize = 16 * 1024 * 1024;
fn validate(text: &str) -> Result<(), String> {
    if text.len() > MAX_EXPORT_BYTES {
        return Err("export_too_large".into());
    }
    let value: serde_json::Value = serde_json::from_str(text).map_err(|_| "export_invalid_json")?;
    if value["format"] == "clawdle-recovery" && value["version"] == 1 && value["snapshot"].is_object() {
        return Ok(());
    }
    if value["format"] != "clawdle-export"
        || value["version"] != 1
        || !value["games"].is_array()
        || !value["results"].is_array()
    {
        return Err("export_invalid_format".into());
    }
    Ok(())
}
fn save_selected(text: &str, path: Option<PathBuf>) -> Result<Option<String>, String> {
    let Some(path) = path else {
        return Ok(None);
    };
    if !path.is_absolute() {
        return Err("export_absolute_path_required".into());
    }
    clawdle_local_runtime::private::atomic_write(&path, text.as_bytes())
        .map_err(|_| "export_save_failed")?;
    Ok(Some(path.to_string_lossy().into_owned()))
}
#[cfg(windows)]
fn choose_path(owner: usize) -> Result<Option<PathBuf>, String> {
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::UI::Controls::Dialogs::{
        CommDlgExtendedError, GetSaveFileNameW, OFN_DONTADDTORECENT, OFN_EXPLORER, OFN_NOCHANGEDIR,
        OFN_OVERWRITEPROMPT, OFN_PATHMUSTEXIST, OPENFILENAMEW,
    };
    let mut path = vec![0u16; 32768];
    let default: Vec<u16> = "clawdle-export.json".encode_utf16().collect();
    path[..default.len()].copy_from_slice(&default);
    let filter: Vec<u16> = "Clawdle data (*.json)\0*.json\0\0".encode_utf16().collect();
    let extension: Vec<u16> = "json\0".encode_utf16().collect();
    let title: Vec<u16> = "Export Clawdle data\0".encode_utf16().collect();
    let mut dialog = OPENFILENAMEW {
        lStructSize: std::mem::size_of::<OPENFILENAMEW>() as u32,
        hwndOwner: owner as _,
        lpstrFilter: filter.as_ptr(),
        nFilterIndex: 1,
        lpstrFile: path.as_mut_ptr(),
        nMaxFile: path.len() as u32,
        lpstrTitle: title.as_ptr(),
        lpstrDefExt: extension.as_ptr(),
        Flags: OFN_OVERWRITEPROMPT
            | OFN_PATHMUSTEXIST
            | OFN_NOCHANGEDIR
            | OFN_EXPLORER
            | OFN_DONTADDTORECENT,
        ..Default::default()
    };
    if unsafe { GetSaveFileNameW(&mut dialog) } == 0 {
        return if unsafe { CommDlgExtendedError() } == 0 {
            Ok(None)
        } else {
            Err("export_dialog_failed".into())
        };
    }
    let len = path
        .iter()
        .position(|c| *c == 0)
        .ok_or("export_path_invalid")?;
    Ok(Some(std::ffi::OsString::from_wide(&path[..len]).into()))
}
pub fn save(owner: usize, text: String) -> Result<Option<String>, String> {
    validate(&text)?;
    #[cfg(windows)]
    {
        save_selected(&text, choose_path(owner)?)
    }
    #[cfg(not(windows))]
    {
        let _ = owner;
        Err("native_export_windows_only".into())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn text() -> String {
        serde_json::json!({"format":"clawdle-export","version":1,"games":[],"results":[],"settings":{},"exportedAtUtc":"2026-10-12T00:00:00Z","statsResetSeq":0}).to_string()
    }
    #[test]
    fn saves_exact_utf8_to_only_selected_path_and_cancels_without_writing() {
        let d = tempfile::tempdir().unwrap();
        let path = d.path().join("Clawdle café.json");
        let text = text();
        validate(&text).unwrap();
        assert_eq!(save_selected(&text, None).unwrap(), None);
        assert!(!path.exists());
        assert_eq!(
            save_selected(&text, Some(path.clone())).unwrap(),
            Some(path.to_string_lossy().into_owned())
        );
        assert_eq!(std::fs::read_to_string(path).unwrap(), text);
    }
    #[test]
    fn bounds_and_validates_export_before_dialog() {
        assert!(validate("bad").is_err());
        assert!(validate("{}").is_err());
        assert!(validate(&" ".repeat(MAX_EXPORT_BYTES + 1)).is_err());
        assert!(save_selected(&text(), Some(PathBuf::from("relative.json"))).is_err());
        assert!(validate(r#"{"format":"clawdle-recovery","version":1,"snapshot":{}}"#).is_ok());
        assert!(validate(r#"{"format":"clawdle-recovery","version":2,"snapshot":{}}"#).is_err());
    }
}
