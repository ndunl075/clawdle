"""SQLite and lifecycle helpers for scripts/acceptance/security.mjs.

  security.db.py snapshot DB            read-only counts of journal rows, results and games (JSON)
  security.db.py lock DB READY STOP N   hold a SQLite write lock until STOP exists or N seconds pass
  security.db.py lifecycle -- ARGS...   run scripts/claude-lifecycle-smoke.py and record its canary and session id

Only used against throwaway test profiles under .local/.
"""
import importlib.util
import json
import os
import sqlite3
import sys
import time
import uuid
from pathlib import Path


def snapshot(db):
    con = sqlite3.connect(Path(db).as_uri() + '?mode=ro', uri=True, timeout=1)
    try:
        kinds = dict(con.execute('SELECT kind, COUNT(*) FROM event_journal GROUP BY kind'))
        commands = [json.loads(p).get('type') for (p,) in con.execute("SELECT payload FROM event_journal WHERE kind='command' ORDER BY seq")]
        row = con.execute('SELECT state_version, processed_seq, state FROM app_checkpoint WHERE id=1').fetchone()
        state = json.loads(row[2]) if row else {}
        games = {gid: {'mode': g.get('mode'), 'status': g.get('status'), 'guesses': [x.get('word') for x in g.get('guesses', [])], 'wordId': g.get('wordId')}
                 for gid, g in (state.get('games') or {}).items()}
        results = [r[0] for r in con.execute('SELECT identity FROM results')]
        return {'journalByKind': kinds, 'commandTypes': commands, 'stateVersion': row[0] if row else None,
                'processedSeq': row[1] if row else None, 'activeGameId': state.get('activeGameId'), 'games': games,
                'resultCount': len(results), 'results': results}
    finally:
        con.close()


def lock(db, ready, stop, seconds):
    con = sqlite3.connect(db, timeout=1, isolation_level=None)
    try:
        con.execute('BEGIN IMMEDIATE')
        Path(ready).write_text('locked', encoding='utf-8')
        deadline = time.monotonic() + float(seconds)
        while time.monotonic() < deadline and not Path(stop).exists():
            time.sleep(.1)
    finally:
        try:
            con.execute('ROLLBACK')
        finally:
            con.close()


def lifecycle(argv):
    """Run the real-CLI smoke and persist the identifiers it generates (uuid4 order: session, then canary)."""
    # The smoke script derives .local from its own location, so run the copy in the checkout that owns .local.
    path = Path(os.environ.get('CLAWDLE_SMOKE_SCRIPT') or Path(__file__).resolve().parents[1] / 'claude-lifecycle-smoke.py')
    spec = importlib.util.spec_from_file_location('claude_lifecycle_smoke', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    real, calls = uuid.uuid4, []

    def recording():
        value = real()
        calls.append(value)
        return value
    uuid.uuid4 = recording
    code = module.main(argv)
    fixture = Path(argv[argv.index('--fixture') + 1])
    session = str(calls[0])
    canary = 'SYNTHETIC_PRIVATE_PROMPT_' + calls[1].hex
    (fixture / 'identifiers.json').write_text(json.dumps({'sessionId': session, 'canary': canary}), encoding='utf-8')
    return code


if __name__ == '__main__':
    command = sys.argv[1]
    if command == 'snapshot':
        print(json.dumps(snapshot(sys.argv[2])))
    elif command == 'lock':
        lock(*sys.argv[2:6])
    elif command == 'lifecycle':
        sys.exit(lifecycle(sys.argv[3:]))
    else:
        sys.exit('unknown command')
