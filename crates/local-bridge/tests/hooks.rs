use std::{
    io::Write,
    process::{Command, Stdio},
    time::{Duration, Instant},
};
#[test]
fn integration_background_lifecycle_uses_only_isolated_settings() {
    let d = tempfile::tempdir().unwrap();
    let data = d.path().join("data");
    let first = d.path().join("first project café");
    let second = d.path().join("second project");
    let invoke = |action: &str, project: &std::path::Path| {
        let result = Command::new(env!("CARGO_BIN_EXE_clawdle-bridge"))
            .args([action, "claude", "--scope", "project", "--project"])
            .arg(project)
            .env("CLAWDLE_TEST_MODE", "1")
            .env("CLAWDLE_DATA_DIR", &data)
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
    };
    assert!(!clawdle_local_runtime::lifecycle::background_enabled(&data));
    invoke("install", &first);
    invoke("install", &second);
    assert!(clawdle_local_runtime::lifecycle::background_enabled(&data));
    invoke("uninstall", &first);
    assert!(clawdle_local_runtime::lifecycle::background_enabled(&data));
    invoke("uninstall", &second);
    assert!(!clawdle_local_runtime::lifecycle::background_enabled(&data));
}
#[test]
fn malformed_hook_is_silent_and_successful() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_clawdle-bridge"))
        .args(["hook", "--provider", "claude"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(b"invalid input")
        .unwrap();
    let result = child.wait_with_output().unwrap();
    assert!(result.status.success());
    assert!(result.stdout.is_empty());
    assert!(result.stderr.is_empty());
}
#[test]
fn blocked_stdin_has_hard_process_deadline() {
    let started = Instant::now();
    let mut child = Command::new(env!("CARGO_BIN_EXE_clawdle-bridge"))
        .args(["hook", "--provider", "claude"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut held = child.stdin.take().unwrap();
    held.write_all(b"{").unwrap();
    let output = child.wait_with_output().unwrap();
    drop(held);
    assert!(output.status.success());
    assert!(output.stdout.is_empty());
    assert!(output.stderr.is_empty());
    assert!(
        started.elapsed() < Duration::from_millis(1500),
        "process startup and watchdog exceeded conservative CI allowance: {:?}",
        started.elapsed()
    );
}
