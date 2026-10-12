//! Lowers the WebView2 memory usage target while the main window is hidden.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Transition {
    Hidden,
    Shown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Level {
    Low,
    Normal,
}

pub fn level_for(transition: Transition) -> Level {
    match transition {
        Transition::Hidden => Level::Low,
        Transition::Shown => Level::Normal,
    }
}

/// Best-effort: failures are logged and never propagate.
pub fn apply(app: &tauri::AppHandle, transition: Transition) {
    #[cfg(windows)]
    {
        use tauri::Manager;
        let Some(window) = app.get_webview_window("main") else {
            return;
        };
        let level = level_for(transition);
        if let Err(e) = window.with_webview(move |webview| {
            if let Err(msg) = set_level(&webview, level) {
                eprintln!("webview memory target {level:?}: {msg}");
            }
        }) {
            eprintln!("webview memory target {level:?}: {e}");
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (app, transition);
    }
}

#[cfg(windows)]
fn set_level(webview: &tauri::webview::PlatformWebview, level: Level) -> Result<(), String> {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_19, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW,
        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
    };
    use windows::core::Interface;
    let core = unsafe { webview.controller().CoreWebView2() }.map_err(|e| e.to_string())?;
    // Older runtimes do not expose ICoreWebView2_19; skip quietly.
    let Ok(core19) = core.cast::<ICoreWebView2_19>() else {
        return Ok(());
    };
    let value = match level {
        Level::Low => COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW,
        Level::Normal => COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
    };
    unsafe { core19.SetMemoryUsageTargetLevel(value) }.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hidden_is_low_and_shown_is_normal() {
        assert_eq!(level_for(Transition::Hidden), Level::Low);
        assert_eq!(level_for(Transition::Shown), Level::Normal);
    }
}
