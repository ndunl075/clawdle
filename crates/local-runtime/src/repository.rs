use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{path::Path, sync::Mutex, time::Instant};

type Result<T> = std::result::Result<T, String>;
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalEntry {
    pub seq: i64,
    pub event_id: String,
    pub runtime_epoch: String,
    pub received_at_utc: String,
    pub received_mono_ms: f64,
    pub kind: String,
    pub payload: Value,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Checkpoint {
    pub state_version: i64,
    pub processed_seq: i64,
    pub state: Value,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultRecord {
    pub result_id: String,
    pub identity: String,
    pub mode: String,
    pub payload: Value,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSnapshot {
    pub runtime_epoch: String,
    pub received_mono_ms: f64,
    pub received_at_utc: String,
    pub latest_seq: i64,
    pub checkpoint: Option<Checkpoint>,
}
pub struct Repository {
    conn: Mutex<Connection>,
    pub epoch: String,
    anchor: Instant,
}
fn db<T>(r: rusqlite::Result<T>) -> Result<T> {
    r.map_err(|_| "storage_error".into())
}
fn payload_hash(v:&Value)->String {
    fn sorted(v:&Value)->Value {match v {Value::Object(map)=>{let mut entries:Vec<_>=map.iter().collect();entries.sort_by(|a,b|a.0.cmp(b.0));Value::Object(entries.into_iter().map(|(k,v)|(k.clone(),sorted(v))).collect())},Value::Array(values)=>Value::Array(values.iter().map(sorted).collect()),_=>v.clone()}}
    format!("{:x}",Sha256::digest(sorted(v).to_string().as_bytes()))
}
fn row(r: &rusqlite::Row<'_>) -> rusqlite::Result<JournalEntry> {
    let json: String = r.get(6)?;
    Ok(JournalEntry {
        seq: r.get(0)?,
        event_id: r.get(1)?,
        runtime_epoch: r.get(2)?,
        received_at_utc: r.get(3)?,
        received_mono_ms: r.get(4)?,
        kind: r.get(5)?,
        payload: serde_json::from_str(&json).map_err(|_| rusqlite::Error::InvalidQuery)?,
    })
}
impl Repository {
    pub fn open(path: &Path) -> Result<Self> {
        if path != Path::new(":memory:") {
            crate::private::reject_links(path).map_err(|_| "unsafe_database_path")?;
        }
        let c = db(Connection::open(path))?;
        db(c.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;
        BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at_utc TEXT NOT NULL);
        INSERT OR IGNORE INTO schema_migrations VALUES(1, strftime('%Y-%m-%dT%H:%M:%fZ','now'));
        CREATE TABLE IF NOT EXISTS event_journal(seq INTEGER PRIMARY KEY AUTOINCREMENT,event_id TEXT UNIQUE NOT NULL,runtime_epoch TEXT NOT NULL,received_at_utc TEXT NOT NULL,received_mono_ms REAL NOT NULL,kind TEXT NOT NULL,payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS event_receipts(event_id TEXT PRIMARY KEY,seq INTEGER NOT NULL,runtime_epoch TEXT NOT NULL,received_at_utc TEXT NOT NULL,received_mono_ms REAL NOT NULL,kind TEXT NOT NULL,payload_hash TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS app_checkpoint(id INTEGER PRIMARY KEY CHECK(id=1), state_version INTEGER NOT NULL, processed_seq INTEGER NOT NULL,state TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS results(result_id TEXT PRIMARY KEY,identity TEXT UNIQUE NOT NULL,mode TEXT NOT NULL,payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS effect_receipts(effect_id TEXT PRIMARY KEY, delivered_at_utc TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS games(game_id TEXT PRIMARY KEY,mode TEXT NOT NULL,payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS daily_games(schedule_version TEXT NOT NULL,daily_key TEXT NOT NULL,game_id TEXT UNIQUE NOT NULL,PRIMARY KEY(schedule_version,daily_key));
        CREATE TABLE IF NOT EXISTS races(race_id TEXT PRIMARY KEY,provider TEXT NOT NULL,session_id TEXT NOT NULL,turn_id TEXT NOT NULL,payload TEXT NOT NULL,UNIQUE(provider,session_id,turn_id));
        CREATE TABLE IF NOT EXISTS speedruns(speedrun_id TEXT PRIMARY KEY,payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS recent_words(word_id TEXT NOT NULL,selection_order INTEGER PRIMARY KEY AUTOINCREMENT);
        COMMIT;"))?;
        let repo = Self {
            conn: Mutex::new(c),
            epoch: uuid::Uuid::new_v4().to_string(),
            anchor: Instant::now(),
        };
        repo.append(
            &uuid::Uuid::new_v4().to_string(),
            "runtime",
            serde_json::json!({"type":"runtime.interrupted"}),
        )?;
        Ok(repo)
    }
    pub fn mono(&self) -> f64 {
        self.anchor.elapsed().as_secs_f64() * 1000.0
    }
    pub fn append(&self, id: &str, kind: &str, payload: Value) -> Result<JournalEntry> {
        if kind == "command" {
            crate::commands::validate(&payload)?;
        }
        if uuid::Uuid::parse_str(id).is_err() || !["agent", "command", "runtime"].contains(&kind) {
            return Err("invalid_event".into());
        }
        let body = serde_json::to_string(&payload).map_err(|_| "invalid_json")?;
        if body.len() > if kind == "agent" { 8192 } else { 65536 } {
            return Err("oversized".into());
        }
        let mut writer = self.conn.lock().map_err(|_| "storage_lock")?;
        let c = db(writer.transaction())?;
        let receipt:Option<(i64,String,String,f64,String,String)>=db(c.query_row("SELECT seq,runtime_epoch,received_at_utc,received_mono_ms,kind,payload_hash FROM event_receipts WHERE event_id=?1",[id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?))).optional())?;
        if let Some((seq, epoch, utc, mono, old_kind, hash)) = receipt {
            if old_kind != kind || hash != payload_hash(&payload) {
                return Err("idempotency_conflict".into());
            }
            return Ok(JournalEntry {
                seq,
                event_id: id.into(),
                runtime_epoch: epoch,
                received_at_utc: utc,
                received_mono_ms: mono,
                kind: kind.into(),
                payload,
            });
        }
        if let Some(old) = db(c.query_row("SELECT seq,event_id,runtime_epoch,received_at_utc,received_mono_ms,kind,payload FROM event_journal WHERE event_id=?1", [id], row).optional())? {
            if old.kind != kind || old.payload != payload { return Err("idempotency_conflict".into()); } return Ok(old);
        }
        // The mutex is the single writer. Receipt clocks are assigned inside it.
        let now = chrono::Utc::now().to_rfc3339();
        let mono = self.mono();
        let count: i64 = db(c.query_row("SELECT COUNT(*) FROM event_journal", [], |r| r.get(0)))?;
        if count >= 100_000 {
            return Err("journal_capacity_recovery_required".into());
        }
        db(c.execute("INSERT INTO event_journal(event_id,runtime_epoch,received_at_utc,received_mono_ms,kind,payload) VALUES(?1,?2,?3,?4,?5,?6)", params![id,self.epoch,now,mono,kind,body]))?;
        let seq = c.last_insert_rowid();
        db(c.execute(
            "INSERT INTO event_receipts VALUES(?1,?2,?3,?4,?5,?6,?7)",
            params![
                id,
                seq,
                self.epoch,
                now,
                mono,
                kind,
                payload_hash(&payload)
            ],
        ))?;
        db(c.commit())?;
        Ok(JournalEntry {
            seq,
            event_id: id.into(),
            runtime_epoch: self.epoch.clone(),
            received_at_utc: now,
            received_mono_ms: mono,
            kind: kind.into(),
            payload,
        })
    }
    pub fn read(&self, after: i64, limit: usize) -> Result<Vec<JournalEntry>> {
        let c = self.conn.lock().map_err(|_| "storage_lock")?;
        let mut q = db(c.prepare("SELECT seq,event_id,runtime_epoch,received_at_utc,received_mono_ms,kind,payload FROM event_journal WHERE seq>?1 ORDER BY seq LIMIT ?2"))?;
        let rows = db(q.query_map(params![after, limit.clamp(1, 1000)], row))?;
        rows.map(db).collect()
    }
    pub fn snapshot(&self) -> Result<RuntimeSnapshot> {
        let c = self.conn.lock().map_err(|_| "storage_lock")?;
        let cp = db(c
            .query_row(
                "SELECT state_version,processed_seq,state FROM app_checkpoint WHERE id=1",
                [],
                |r| {
                    let s: String = r.get(2)?;
                    Ok(Checkpoint {
                        state_version: r.get(0)?,
                        processed_seq: r.get(1)?,
                        state: serde_json::from_str(&s)
                            .map_err(|_| rusqlite::Error::InvalidQuery)?,
                    })
                },
            )
            .optional())?;
        let seq = db(
            c.query_row("SELECT COALESCE(MAX(seq),0) FROM event_journal", [], |r| {
                r.get(0)
            }),
        )?;
        Ok(RuntimeSnapshot {
            runtime_epoch: self.epoch.clone(),
            received_mono_ms: self.mono(),
            received_at_utc: chrono::Utc::now().to_rfc3339(),
            latest_seq: seq,
            checkpoint: cp,
        })
    }
    pub fn commit(
        &self,
        expected: i64,
        processed: i64,
        state: Value,
        results: Vec<ResultRecord>,
    ) -> Result<Checkpoint> {
        if serde_json::to_vec(&state)
            .map_err(|_| "invalid_json")?
            .len()
            > 16 * 1024 * 1024
        {
            return Err("checkpoint_oversized".into());
        }
        let mut c = self.conn.lock().map_err(|_| "storage_lock")?;
        let tx = db(c.transaction())?;
        let (version, old_seq) = db(tx
            .query_row(
                "SELECT state_version,processed_seq FROM app_checkpoint WHERE id=1",
                [],
                |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)),
            )
            .optional())?
        .unwrap_or((0, 0));
        if version != expected {
            return Err("checkpoint_conflict".into());
        }
        let available: i64 = db(tx.query_row(
            "SELECT COUNT(*) FROM event_journal WHERE seq>?1 AND seq<=?2",
            params![old_seq, processed],
            |r| r.get(0),
        ))?;
        if processed < old_seq || available != processed - old_seq {
            return Err("noncontiguous_checkpoint".into());
        }
        let previous: Option<String> = db(tx
            .query_row("SELECT state FROM app_checkpoint WHERE id=1", [], |r| {
                r.get(0)
            })
            .optional())?;
        let old_reset = previous
            .as_ref()
            .and_then(|s| serde_json::from_str::<Value>(s).ok())
            .and_then(|s| s["dataResetSeq"].as_i64())
            .unwrap_or(0);
        if state["dataResetSeq"].as_i64().unwrap_or(0) > old_reset {
            db(tx.execute_batch("DELETE FROM games;DELETE FROM daily_games;DELETE FROM results;DELETE FROM races;DELETE FROM speedruns;DELETE FROM settings;DELETE FROM recent_words;"))?;
        }
        if let Some(games) = state["games"].as_object() {
            for (id, game) in games {
                let mode = game["mode"].as_str().ok_or("invalid_game_mode")?;
                db(tx.execute("INSERT INTO games VALUES(?1,?2,?3) ON CONFLICT(game_id) DO UPDATE SET payload=excluded.payload",params![id,mode,game.to_string()]))?;
                if mode == "daily" {
                    let day = game["dailyKey"].as_str().ok_or("invalid_daily_key")?;
                    let existing:Option<String>=db(tx.query_row("SELECT game_id FROM daily_games WHERE schedule_version='daily-v1' AND daily_key=?1",[day],|r|r.get(0)).optional())?;
                    if existing.as_ref().is_some_and(|g| g != id) {
                        return Err("daily_already_exists".into());
                    }
                    db(tx.execute(
                        "INSERT OR IGNORE INTO daily_games VALUES('daily-v1',?1,?2)",
                        params![day, id],
                    ))?;
                }
            }
        }
        if let Some(races) = state["races"].as_object() {
            for (id, race) in races {
                db(tx.execute("INSERT INTO races VALUES(?1,?2,?3,?4,?5) ON CONFLICT(race_id) DO UPDATE SET payload=excluded.payload",params![id,race["provider"].as_str().ok_or("race_provider")?,race["sessionId"].as_str().ok_or("race_session")?,race["turnId"].as_str().ok_or("race_turn")?,race.to_string()]))?;
            }
        }
        if let Some(runs) = state["speedruns"].as_object() {
            for (id, run) in runs {
                db(tx.execute("INSERT INTO speedruns VALUES(?1,?2) ON CONFLICT(speedrun_id) DO UPDATE SET payload=excluded.payload",params![id,run.to_string()]))?;
            }
        }
        if let Some(settings) = state["settings"].as_object() {
            for (key, value) in settings {
                db(tx.execute("INSERT INTO settings VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![key,value.to_string()]))?;
            }
        }
        for result in results {
            let existing: Option<String> = db(tx
                .query_row(
                    "SELECT payload FROM results WHERE result_id=?1 OR identity=?2",
                    params![result.result_id, result.identity],
                    |r| r.get(0),
                )
                .optional())?;
            let body = serde_json::to_string(&result.payload).map_err(|_| "invalid_json")?;
            if let Some(old) = existing {
                if old != body {
                    return Err("terminal_result_conflict".into());
                }
            } else {
                db(tx.execute(
                    "INSERT INTO results VALUES(?1,?2,?3,?4)",
                    params![result.result_id, result.identity, result.mode, body],
                ))?;
            }
        }
        db(tx.execute("INSERT INTO app_checkpoint VALUES(1,?1,?2,?3) ON CONFLICT(id) DO UPDATE SET state_version=excluded.state_version,processed_seq=excluded.processed_seq,state=excluded.state",params![version+1,processed,state.to_string()]))?;
        // Only compact processed entries older than the 24-hour retry window.
        let old_entries = {
            let mut q=db(tx.prepare("SELECT seq,payload FROM event_journal WHERE seq<?1 AND julianday(received_at_utc)<julianday('now','-1 day') LIMIT 1000"))?;
            let rows = db(q.query_map([processed], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
            }))?;
            rows.map(db).collect::<Result<Vec<_>>>()?
        };
        for (seq, body) in old_entries {
            let event: Value = serde_json::from_str(&body).map_err(|_| "journal_json")?;
            let unresolved = state["races"].as_object().is_some_and(|races| {
                races.values().any(|r| {
                    r["state"] != "terminal"
                        && r["provider"] == event["provider"]
                        && r["sessionId"] == event["sessionId"]
                        && r["turnId"] == event["turnId"]
                })
            });
            if !unresolved {
                db(tx.execute("DELETE FROM event_journal WHERE seq=?1", [seq]))?;
            }
        }
        db(tx.execute("DELETE FROM event_receipts WHERE julianday(received_at_utc)<julianday('now','-7 days') AND seq<?1",[processed]))?;
        db(tx.execute("DELETE FROM effect_receipts WHERE julianday(delivered_at_utc)<julianday('now','-7 days')",[]))?;
        db(tx.commit())?;
        Ok(Checkpoint {
            state_version: version + 1,
            processed_seq: processed,
            state,
        })
    }
    pub fn claim_effect(&self, id: &str) -> Result<bool> {
        if id.len() > 256 {
            return Err("effect_id".into());
        }
        let c = self.conn.lock().map_err(|_| "storage_lock")?;
        Ok(db(c.execute(
            "INSERT OR IGNORE INTO effect_receipts VALUES(?1,?2)",
            params![id, chrono::Utc::now().to_rfc3339()],
        ))? == 1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn compaction_preserves_receipts_unprocessed_entries_and_sequence() {
        let repo = Repository::open(Path::new(":memory:")).unwrap();
        let first = repo.read(0, 10).unwrap().remove(0);
        let second = repo
            .append(
                &uuid::Uuid::new_v4().to_string(),
                "command",
                serde_json::json!({"type":"startEndless"}),
            )
            .unwrap();
        let third = repo
            .append(
                &uuid::Uuid::new_v4().to_string(),
                "command",
                serde_json::json!({"type":"startDaily"}),
            )
            .unwrap();
        repo.conn
            .lock()
            .unwrap()
            .execute(
                "UPDATE event_journal SET received_at_utc='2020-01-01T00:00:00Z'",
                [],
            )
            .unwrap();
        repo.commit(0, second.seq, Value::Null, vec![]).unwrap();
        let entries = repo.read(0, 10).unwrap();
        assert_eq!(
            entries.iter().map(|e| e.seq).collect::<Vec<_>>(),
            vec![second.seq, third.seq]
        );
        assert_eq!(
            repo.append(&first.event_id, "runtime", first.payload)
                .unwrap()
                .seq,
            first.seq
        );
        let fourth = repo
            .append(
                &uuid::Uuid::new_v4().to_string(),
                "command",
                serde_json::json!({"type":"tick"}),
            )
            .unwrap();
        assert_eq!(fourth.seq, third.seq + 1);
    }
    #[test]
    fn ordering_idempotency_and_atomic_conflicts() {
        let repo = Repository::open(Path::new(":memory:")).unwrap();
        let a = uuid::Uuid::new_v4().to_string();
        let first = repo
            .append(
                &a,
                "command",
                serde_json::json!({"type":"submitGuess","word":"APPLE"}),
            )
            .unwrap();
        assert_eq!(first.seq, 2);
        assert_eq!(
            repo.append(&a, "command", first.payload.clone())
                .unwrap()
                .seq,
            2
        );
        assert!(repo.append(&a, "command", Value::Null).is_err());
        assert!(repo.commit(0, 3, Value::Null, vec![]).is_err());
        let cp = repo
            .commit(0, 2, serde_json::json!({"schemaVersion":1}), vec![])
            .unwrap();
        assert_eq!(cp.state_version, 1);
        assert!(repo.commit(0, 2, Value::Null, vec![]).is_err());
        assert_eq!(
            repo.snapshot().unwrap().checkpoint.unwrap().state_version,
            1
        );
    }
    #[test]
    fn restart_preserves_and_marks_interruption() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.sqlite");
        {
            let repo = Repository::open(&path).unwrap();
            repo.commit(0, 1, serde_json::json!({"puzzle":"preserved"}), vec![])
                .unwrap();
        }
        let repo = Repository::open(&path).unwrap();
        assert_eq!(
            repo.read(1, 10).unwrap()[0].payload["type"],
            "runtime.interrupted"
        );
        assert_eq!(
            repo.snapshot().unwrap().checkpoint.unwrap().state["puzzle"],
            "preserved"
        );
    }
    #[test]
    fn result_conflict_rolls_back_checkpoint() {
        let repo = Repository::open(Path::new(":memory:")).unwrap();
        let result = ResultRecord {
            result_id: "r".into(),
            identity: "g".into(),
            mode: "daily".into(),
            payload: serde_json::json!({"win":true}),
        };
        repo.commit(0, 1, Value::Null, vec![result.clone()])
            .unwrap();
        let mut wrong = result;
        wrong.payload = Value::Null;
        assert!(repo.commit(1, 1, Value::Bool(true), vec![wrong]).is_err());
        assert_eq!(
            repo.snapshot().unwrap().checkpoint.unwrap().state_version,
            1
        );
        assert!(repo.claim_effect("show:1").unwrap());
        assert!(!repo.claim_effect("show:1").unwrap());
    }
}

