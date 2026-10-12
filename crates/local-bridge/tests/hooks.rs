use std::{
    io::Write,
    process::{Command, Stdio},
    time::{Duration, Instant},
};
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
