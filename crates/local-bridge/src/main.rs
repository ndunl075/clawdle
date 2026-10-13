#![cfg_attr(windows, windows_subsystem = "console")]
use clawdle_local_runtime::{private, settings};
use std::{
    io::{Read, Write},
    net::{Ipv4Addr, SocketAddrV4, TcpStream},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

/// Hook budget measured from the start of main. The hard limit is 300 ms of process wall-clock, and
/// process start and teardown take about 25-30 ms (more under load), so the in-process deadline
/// leaves that headroom.
/// The receiver acks only after a durable fsync, whose tail latency on a loaded disk can pass
/// 100 ms, so an attempt may use about half of the budget and the retry (same eventId,
/// deduplicated) gets the rest.
const HOOK_DEADLINE_MS: u64 = 200;
const HOOK_ATTEMPT_MS: u64 = 100;
/// A loopback connect to a listening receiver completes in the kernel without waiting for the app,
/// while a refused loopback connect on Windows is retried for about a second before failing. A short
/// connect cap makes "receiver not running" fail fast instead of consuming the whole budget.
const CONNECT_MS: u64 = 40;

fn deliver(
    dir: &Path,
    event: &clawdle_agent_adapters::AgentEvent,
    deadline: Instant,
) -> Result<(), String> {
    let endpoint = private::endpoint(dir).map_err(|_| "endpoint_unavailable")?;
    let token = private::token(dir).map_err(|_| "token_unavailable")?;
    let body = serde_json::to_vec(event).map_err(|_| "event_json")?;
    for _ in 0..2 {
        let budget = deadline
            .saturating_duration_since(Instant::now())
            .min(Duration::from_millis(HOOK_ATTEMPT_MS));
        if budget < Duration::from_millis(2) {
            break;
        }
        if let Ok(mut socket) = TcpStream::connect_timeout(
            &SocketAddrV4::new(Ipv4Addr::LOCALHOST, endpoint.port).into(),
            budget.min(Duration::from_millis(CONNECT_MS)),
        ) {
            let _ = socket.set_read_timeout(Some(budget));
            let _ = socket.set_write_timeout(Some(budget));
            let request=format!("POST /v1/events HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",endpoint.port,token,body.len());
            if socket.write_all(request.as_bytes()).is_ok() && socket.write_all(&body).is_ok() {
                let mut response = [0u8; 128];
                if let Ok(n) = socket.read(&mut response) {
                    if response[..n].starts_with(b"HTTP/1.1 202") {
                        return Ok(());
                    }
                }
            }
        }
    }
    Err("receiver_unavailable".into())
}
fn hook(dir: PathBuf) {
    // The watchdog covers stdin, metadata parsing, filesystem discovery, delivery and launch.
    // Dropping the receiver and returning from main ends any stuck worker thread.
    let (tx, rx) = std::sync::mpsc::channel();
    let deadline = Instant::now() + Duration::from_millis(HOOK_DEADLINE_MS);
    std::thread::spawn(move || {
        let result = (|| {
            let mut raw = vec![];
            std::io::stdin()
                .take(4 * 1024 * 1024 + 1)
                .read_to_end(&mut raw)
                .map_err(|_| "stdin")?;
            if raw.len() > 4 * 1024 * 1024 {
                return Err("oversized");
            }
            let token = private::token(&dir).map_err(|_| "private_token")?;
            let Some(event) = clawdle_agent_adapters::parse_claude(&raw, token.as_bytes())? else {
                return Ok(());
            };
            drop(raw);
            if deliver(&dir, &event, deadline).is_err() {
                cold_start(&dir, &event).map_err(|_| "cold_start")?;
            }
            Ok::<(), &str>(())
        })();
        let _ = tx.send(result);
    });
    let _ = rx.recv_timeout(deadline.saturating_duration_since(Instant::now()));
}
fn cold_start(dir: &Path, event: &clawdle_agent_adapters::AgentEvent) -> std::io::Result<()> {
    let config_path = dir.join("bridge.json");
    private::reject_links(&config_path)?;
    let config: serde_json::Value = serde_json::from_slice(&std::fs::read(config_path)?)?;
    if config["autoLaunch"].as_bool() != Some(true) {
        return Ok(());
    }
    let desktop = Path::new(
        config["desktopPath"]
            .as_str()
            .ok_or_else(|| std::io::Error::other("desktop_path"))?,
    );
    if !desktop.is_absolute() || !desktop.is_file() {
        return Err(std::io::Error::other("desktop_missing"));
    }
    let mailbox = dir.join("mailbox");
    let starting = mailbox.is_dir()
        && std::fs::read_dir(&mailbox)?.any(|e| {
            e.ok()
                .and_then(|e| e.metadata().ok())
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.elapsed().ok())
                .is_some_and(|d| d.as_secs() <= 30)
        });
    if !starting && !(event.event_type == "agent.started" && event.scope == "root") {
        return Ok(());
    }
    private::mailbox_write(dir, event)?;
    if !starting {
        let mut command = std::process::Command::new(desktop);
        command
            .arg("--hook-launch")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000 | 0x00000200);
        }
        let _ = command.spawn()?;
    }
    Ok(())
}
fn argument(args: &[String], key: &str) -> Option<String> {
    args.iter()
        .position(|a| a == key)
        .and_then(|i| args.get(i + 1))
        .cloned()
}
fn diagnostics(dir: &Path) -> serde_json::Value {
    let endpoint = private::endpoint(dir).ok();
    let token_present = private::reject_links(&dir.join("token")).is_ok()
        && std::fs::metadata(dir.join("token")).is_ok_and(|m| m.len() == 64);
    let available = endpoint.as_ref().is_some_and(|e| {
        TcpStream::connect_timeout(
            &SocketAddrV4::new(Ipv4Addr::LOCALHOST, e.port).into(),
            Duration::from_millis(100),
        )
        .is_ok()
    });
    let user = settings::settings_path("user", None).ok();
    serde_json::json!({"protocolVersion":1,"tokenPresent":token_present,"receiverAvailable":available,"development":endpoint.as_ref().is_some_and(|e|e.development),"ownedUserHandlers":user.as_ref().map(|p|settings::owned_count(p,&dir.join("ownership"))).unwrap_or(0),"claudeCompatibility":"Requires documented prompt_id and command args support. Run synthetic smoke check and refresh Claude session after setup.","supportedTarget":"Windows native Claude Code"})
}
fn run(args: &[String]) -> Result<(), String> {
    let development = args.iter().any(|a| a == "--development");
    let dir = clawdle_local_runtime::data_dir(development);
    match args.first().map(String::as_str){Some("install"|"uninstall")=>{if args.get(1).map(String::as_str)!=Some("claude"){return Err("provider_must_be_claude".into());}private::secure_dir(&dir).map_err(|_|"private_directory")?;let scope=argument(args,"--scope").unwrap_or("user".into());let project=argument(args,"--project").map(PathBuf::from);let path=settings::settings_path(&scope,project.as_deref())?;let exe=std::env::current_exe().map_err(|_|"executable_path")?;settings::prepare_for(&path,&dir.join("ownership"),&exe,args[0]=="install",development)?.commit()?;clawdle_local_runtime::lifecycle::set_background(&dir,args[0]=="install"||settings::has_owned_handlers(&dir.join("ownership"))).map_err(|_|"background_preference_save")?;println!("{}",serde_json::json!({"status":"ok","refreshClaudeSession":true,"scope":scope}));},Some("doctor")=>println!("{}",diagnostics(&dir)),Some("simulate")=>{let endpoint=private::endpoint(&dir).map_err(|_|"receiver_unavailable")?;if !endpoint.development{return Err("simulation_requires_development_receiver".into());}let scenario=argument(args,"--scenario").unwrap_or("player-win".into());if !["player-win","agent-first","attention","child","missing-turn","provider-error"].contains(&scenario.as_str()){return Err("unknown_scenario".into());}let session=uuid::Uuid::new_v4().to_string();let turn=uuid::Uuid::new_v4().to_string();let token=private::token(&dir).map_err(|_|"token_unavailable")?;for hook in if scenario=="agent-first"{vec!["UserPromptSubmit","Stop"]}else if scenario=="attention"{vec!["UserPromptSubmit","PermissionRequest"]}else if scenario=="provider-error"{vec!["UserPromptSubmit","StopFailure"]}else if scenario=="child"{vec!["UserPromptSubmit","SubagentStop"]}else{vec!["UserPromptSubmit"]}{let mut input=serde_json::json!({"session_id":session,"prompt_id":turn,"hook_event_name":hook});if scenario=="missing-turn"{input.as_object_mut().unwrap().remove("prompt_id");}let e=clawdle_agent_adapters::parse_claude(&serde_json::to_vec(&input).unwrap(),token.as_bytes()).map_err(str::to_owned)?.unwrap();deliver(&dir,&e,Instant::now()+Duration::from_millis(150))?;}println!("Synthetic scenario delivered; player-win leaves the turn active for a real player solve.");},_=>return Err("Usage: clawdle-bridge hook --provider claude | install/uninstall claude --scope user|project [--project PATH] | doctor | simulate --scenario NAME [--development]".into())}
    Ok(())
}
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("hook") {
        if argument(&args, "--provider").as_deref() == Some("claude") {
            hook(clawdle_local_runtime::data_dir(
                args.iter().any(|a| a == "--development"),
            ));
        }
        return;
    }
    if let Err(code) = run(&args) {
        eprintln!("{code}");
        std::process::exit(1);
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(port: u16) -> tempfile::TempDir {
        let d = tempfile::tempdir().unwrap();
        private::secure_dir(d.path()).unwrap();
        let endpoint = private::Endpoint {
            protocol_version: 1,
            port,
            runtime_epoch: "test".into(),
            pid: std::process::id(),
            development: true,
        };
        private::atomic_write(
            &d.path().join("endpoint.json"),
            &serde_json::to_vec(&endpoint).unwrap(),
        )
        .unwrap();
        private::token(d.path()).unwrap();
        d
    }
    fn event() -> clawdle_agent_adapters::AgentEvent {
        clawdle_agent_adapters::parse_claude(
            br#"{"hook_event_name":"Stop","session_id":"s","prompt_id":"p"}"#,
            b"salt",
        )
        .unwrap()
        .unwrap()
    }
    #[test]
    fn receiver_down_fails_fast() {
        // Bind and drop to get a loopback port with nothing listening.
        let port = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let d = fixture(port);
        let started = Instant::now();
        let deadline = started + Duration::from_millis(HOOK_DEADLINE_MS);
        assert!(deliver(d.path(), &event(), deadline).is_err());
        assert!(
            started.elapsed() < Duration::from_millis(2 * CONNECT_MS + 40),
            "{:?}",
            started.elapsed()
        );
    }
    #[test]
    fn budget_leaves_process_headroom() {
        assert!(HOOK_DEADLINE_MS + 80 <= 300);
        assert!(2 * HOOK_ATTEMPT_MS <= HOOK_DEADLINE_MS);
        assert!(CONNECT_MS < HOOK_ATTEMPT_MS);
    }
}
