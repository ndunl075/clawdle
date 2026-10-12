use std::{ffi::OsStr, path::PathBuf};

fn browser_dir(mode: Option<&OsStr>, dir: Option<&OsStr>) -> Option<PathBuf> {
    if mode != Some(OsStr::new("1")) {
        return None;
    }
    dir.map(PathBuf::from)
        .filter(|p| p.is_absolute() && p.parent().is_some())
        .map(|p| p.join("webview"))
}

pub fn configure() -> std::io::Result<()> {
    let mode = std::env::var_os("CLAWDLE_TEST_MODE");
    let dir = std::env::var_os("CLAWDLE_DATA_DIR");
    if let Some(path) = browser_dir(mode.as_deref(), dir.as_deref()) {
        clawdle_local_runtime::private::secure_dir(&path)?;
        // Called before Tauri/WebView2 or application worker threads are created.
        std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", path);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_explicit_absolute_test_profile_is_used() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().as_os_str();
        assert_eq!(browser_dir(None, Some(path)), None);
        assert_eq!(browser_dir(Some(OsStr::new("0")), Some(path)), None);
        assert_eq!(browser_dir(Some(OsStr::new("1")), None), None);
        assert_eq!(
            browser_dir(Some(OsStr::new("1")), Some(OsStr::new("relative"))),
            None
        );
        assert_eq!(
            browser_dir(Some(OsStr::new("1")), Some(path)),
            Some(temp.path().join("webview"))
        );
    }
}
