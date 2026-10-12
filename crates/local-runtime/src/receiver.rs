use crate::{
    private::{self, Endpoint},
    Repository,
};
use axum::{
    body::{to_bytes, Body},
    extract::State,
    http::{Request, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use subtle::ConstantTimeEq;
#[derive(Clone)]
struct Intake {
    repo: Arc<Repository>,
    token: Arc<String>,
    port: u16,
    budget: Arc<Mutex<(Instant, u32)>>,
    notify: Arc<dyn Fn(i64) + Send + Sync>,
}
fn authorized(req: &Request<Body>, s: &Intake) -> bool {
    if req.headers().contains_key("origin") || req.uri().query().is_some() {
        return false;
    }
    let expected = format!("127.0.0.1:{}", s.port);
    if req.headers().get("host").and_then(|h| h.to_str().ok()) != Some(expected.as_str()) {
        return false;
    }
    let auth = req
        .headers()
        .get("authorization")
        .map(|s| s.as_bytes())
        .unwrap_or_default();
    let expected = format!("Bearer {}", s.token);
    auth.ct_eq(expected.as_bytes()).into()
}
async fn health(State(s): State<Intake>, req: Request<Body>) -> Response {
    if !authorized(&req, &s) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    Json(serde_json::json!({"protocolVersion":1,"runtimeEpoch":s.repo.epoch})).into_response()
}
async fn event(State(s): State<Intake>, req: Request<Body>) -> Response {
    if !authorized(&req, &s) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    if req
        .headers()
        .get("content-type")
        .and_then(|h| h.to_str().ok())
        != Some("application/json")
    {
        return StatusCode::UNSUPPORTED_MEDIA_TYPE.into_response();
    }
    {
        let mut budget = s.budget.lock().unwrap_or_else(|e| e.into_inner());
        if budget.0.elapsed() > Duration::from_secs(1) {
            *budget = (Instant::now(), 0);
        }
        budget.1 += 1;
        if budget.1 > 100 {
            return StatusCode::TOO_MANY_REQUESTS.into_response();
        }
    }
    let body =
        match tokio::time::timeout(Duration::from_millis(100), to_bytes(req.into_body(), 8192))
            .await
        {
            Ok(Ok(b)) => b,
            _ => return StatusCode::PAYLOAD_TOO_LARGE.into_response(),
        };
    let event: clawdle_agent_adapters::AgentEvent = match serde_json::from_slice(&body) {
        Ok(e) => e,
        Err(_) => return StatusCode::BAD_REQUEST.into_response(),
    };
    if event.validate().is_err() {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let value = serde_json::to_value(&event).expect("typed event");
    let id = event.event_id;
    // Enter the same native writer synchronously as player commands. Scheduling a
    // separate blocking task here could let a later guess overtake a received Stop.
    match s.repo.append(&id, "agent", value) {
        Ok(entry) => {
            (s.notify)(entry.seq);
            (
                StatusCode::ACCEPTED,
                Json(serde_json::json!({"seq":entry.seq})),
            )
                .into_response()
        }
        _ => StatusCode::INSUFFICIENT_STORAGE.into_response(),
    }
}
pub struct Receiver {
    pub endpoint: Endpoint,
    dir: PathBuf,
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
}
impl Drop for Receiver {
    fn drop(&mut self) {
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
        if private::endpoint(&self.dir)
            .is_ok_and(|e| e.runtime_epoch == self.endpoint.runtime_epoch)
        {
            let _ = std::fs::remove_file(self.dir.join("endpoint.json"));
        }
    }
}
pub async fn start(
    dir: PathBuf,
    repo: Arc<Repository>,
    development: bool,
    notify: Arc<dyn Fn(i64) + Send + Sync>,
) -> std::io::Result<Receiver> {
    private::secure_dir(&dir)?;
    let token = private::token(&dir)?;
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await?;
    let port = listener.local_addr()?.port();
    let state = Intake {
        repo: repo.clone(),
        token: Arc::new(token),
        port,
        budget: Arc::new(Mutex::new((Instant::now(), 0))),
        notify: notify.clone(),
    };
    let app = Router::new()
        .route("/v1/events", post(event))
        .route("/v1/health", get(health))
        .with_state(state);
    let (tx, rx) = tokio::sync::oneshot::channel();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = rx.await;
            })
            .await;
    });
    let endpoint = Endpoint {
        protocol_version: 1,
        port,
        runtime_epoch: repo.epoch.clone(),
        pid: std::process::id(),
        development,
    };
    private::atomic_write(&dir.join("endpoint.json"), &serde_json::to_vec(&endpoint)?)?;
    for (path, e) in private::mailbox_drain(&dir)? {
        if let Ok(entry) = repo.append(&e.event_id, "agent", serde_json::to_value(&e).unwrap()) {
            let _ = std::fs::remove_file(path);
            notify(entry.seq);
        }
    }
    Ok(Receiver {
        endpoint,
        dir,
        shutdown: Some(tx),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn auth_limits_privacy_and_dedup() {
        let d = tempfile::tempdir().unwrap();
        let r = Arc::new(Repository::open(std::path::Path::new(":memory:")).unwrap());
        let receiver = start(d.path().into(), r.clone(), true, Arc::new(|_| {}))
            .await
            .unwrap();
        let url = format!("http://127.0.0.1:{}/v1/events", receiver.endpoint.port);
        let c = reqwest::Client::new();
        let e = clawdle_agent_adapters::parse_claude(
            br#"{"hook_event_name":"Stop","session_id":"s","prompt_id":"p"}"#,
            b"salt",
        )
        .unwrap()
        .unwrap();
        assert_eq!(c.post(&url).json(&e).send().await.unwrap().status(), 401);
        let token = private::token(d.path()).unwrap();
        assert_eq!(
            c.post(&url)
                .bearer_auth(&token)
                .header("Origin", "https://evil.invalid")
                .json(&e)
                .send()
                .await
                .unwrap()
                .status(),
            401
        );
        assert_eq!(
            c.post(&url)
                .bearer_auth(&token)
                .header("Host", "evil.invalid")
                .json(&e)
                .send()
                .await
                .unwrap()
                .status(),
            401
        );
        for _ in 0..2 {
            assert_eq!(
                c.post(&url)
                    .bearer_auth(&token)
                    .json(&e)
                    .send()
                    .await
                    .unwrap()
                    .status(),
                202
            );
        }
        assert_eq!(r.read(0, 10).unwrap().len(), 2);
        assert_eq!(
            c.post(&url)
                .bearer_auth(&token)
                .header("Content-Type", "application/json")
                .body("x".repeat(9000))
                .send()
                .await
                .unwrap()
                .status(),
            413
        );
    }
}
