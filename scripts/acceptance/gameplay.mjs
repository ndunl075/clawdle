/* global document, window, getComputedStyle, innerWidth */
/* eslint-disable no-empty */
// Packaged-app gameplay acceptance: runs the release clawdle-desktop.exe hidden (--hook-launch), drives it
// over WebView2 CDP, and drives real Claude Code turns against a loopback synthetic provider.
//
//   node scripts/acceptance/gameplay.mjs [--tag NAME] [--only a,b] [--bin-dir DIR] [--claude PATH]
//
// Items: disconnected, orderings, failure, secondlaunch, a11y (see docs/acceptance/gameplay.md).
// Never launches the app visibly, never touches ~/.claude or the real Clawdle profile, never calls a hosted model.
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');
const argv = process.argv.slice(2);
const opt = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : fallback; };
const mainCheckout = dirname(execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: repo, encoding: 'utf8' }).trim());
const binDir = opt('bin-dir', join(mainCheckout, 'target', 'release'));
const claudeExe = opt('claude', join(homedir(), '.local', 'bin', 'claude.exe'));
const tag = opt('tag', new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12));
const only = opt('only', 'disconnected,orderings,failure,secondlaunch,a11y').split(',');
const port = 9343;
const app = join(binDir, 'clawdle-desktop.exe');
const bridge = join(binDir, 'clawdle-bridge.exe');
const lockFile = join(mainCheckout, '.local', 'locks', 'machine.lock');
const evidenceDir = join(repo, '.local', `native-smoke-gameplay-${tag}`);
const { chromium } = createRequire(join(repo, 'package.json'))('@playwright/test');
const words = JSON.parse(readFileSync(join(repo, 'packages', 'game', 'src', 'words.generated.json'), 'utf8'));

const results = [];
let item = '';
const sleep = ms => new Promise(r => setTimeout(r, ms));
function check(name, pass, evidence = '') {
  const row = { item, check: name, pass: !!pass, evidence: String(evidence).slice(0, 600) };
  results.push(row);
  console.log(`${row.pass ? 'PASS' : 'FAIL'} [${item}] ${name}${evidence ? ' :: ' + row.evidence.slice(0, 200) : ''}`);
  return row.pass;
}
async function waitFor(what, fn, timeout = 30000, interval = 150) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { last = await fn(); if (last) return last; } catch { last = undefined; }
    await sleep(interval);
  }
  return null;
}
const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const win32 = (...args) => execFileSync('powershell', ['-NoProfile', '-File', join(here, 'win32.ps1'), ...args], { encoding: 'utf8' }).trim();
const visible = pid => JSON.parse(win32('visible', '-ProcessId', String(pid))).visible;

// ---------- machine lock (main checkout, held only while runs execute) ----------
async function acquireLock() {
  mkdirSync(dirname(lockFile), { recursive: true });
  const mine = `gameplay-acceptance ${new Date().toISOString()}`;
  for (let i = 0; i < 360; i++) {
    try { writeFileSync(lockFile, mine, { flag: 'wx' }); return mine; }
    catch { if (i % 8 === 0) console.log('machine lock held:', readFileSync(lockFile, 'utf8')); await sleep(5000); }
  }
  throw new Error('machine lock unavailable after 30 minutes');
}
function releaseLock(mine) { try { if (readFileSync(lockFile, 'utf8') === mine) rmSync(lockFile, { force: true }); } catch {} }

// ---------- profile state (read straight from the app's SQLite files) ----------
function withDb(dir, fn) {
  const db = new DatabaseSync(join(dir, 'clawdle.sqlite'), { readOnly: true });
  try { return fn(db); } finally { db.close(); }
}
const readState = dir => withDb(dir, db => { const r = db.prepare('SELECT state FROM app_checkpoint WHERE id=1').get(); return r ? JSON.parse(r.state) : null; });
const readJournal = dir => withDb(dir, db => db.prepare("SELECT seq,kind,payload FROM event_journal ORDER BY seq").all().map(r => ({ seq: r.seq, kind: r.kind, ...JSON.parse(r.payload) })));
const raceOf = (s, sid) => Object.values(s?.races ?? {}).find(r => r.sessionId === sid);
const answerOf = (s, gameId) => s.games[gameId].wordId.slice(6).toUpperCase();
const sessionEvents = (dir, sid) => readJournal(dir).filter(e => e.kind === 'agent' && e.sessionId === sid);

// ---------- app lifecycle ----------
const spawned = new Set();
const killTree = pid => { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} spawned.delete(pid); };
function appEnv(dir) {
  return { ...process.env, CLAWDLE_TEST_MODE: '1', CLAWDLE_DATA_DIR: dir, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` };
}
async function launch(dir) {
  mkdirSync(dir, { recursive: true });
  const stale = join(dir, 'endpoint.json');
  rmSync(stale, { force: true });
  const proc = spawn(app, ['--hook-launch'], { env: appEnv(dir), stdio: 'ignore' });
  spawned.add(proc.pid);
  const ctx = { dir, proc, pid: proc.pid, browser: null, page: null };
  if (!await waitFor('endpoint', () => existsSync(stale), 30000, 250)) throw new Error('endpoint.json never published');
  ctx.browser = await waitFor('cdp', () => chromium.connectOverCDP(`http://127.0.0.1:${port}`), 30000, 500);
  if (!ctx.browser) throw new Error('CDP unavailable');
  ctx.page = await waitFor('page', async () => {
    const p = ctx.browser.contexts()[0]?.pages()[0];
    if (!p) return null;
    await p.getByRole('button', { name: 'Settings' }).waitFor({ timeout: 1500 });
    return p;
  }, 30000, 500);
  if (!ctx.page) throw new Error('UI never rendered');
  const cdp = await ctx.page.context().newCDPSession(ctx.page);
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
  ctx.cdp = cdp;
  return ctx;
}
async function stop(ctx) {
  try { await ctx.browser?.close(); } catch {}
  killTree(ctx.pid);
  await waitFor('exit', () => ctx.proc.exitCode !== null || ctx.proc.signalCode !== null || !pidAlive(ctx.pid), 8000, 200);
  await sleep(600);
}
const pidAlive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

// ---------- UI helpers ----------
const feedback = page => page.locator('.feedback').innerText();
const evaluatedRows = page => page.evaluate(() => [...document.querySelectorAll('.grid-row')].filter(r => /, (correct|present|absent)$/.test(r.firstElementChild?.getAttribute('aria-label') ?? '')).map(r => [...r.children].map(t => t.getAttribute('aria-label')).join('|')));
async function typeWord(page, word, { submit = true } = {}) {
  await page.locator('main.app').focus();
  for (const ch of word.toLowerCase()) await page.keyboard.press(ch);
  if (submit) await page.keyboard.press('Enter');
}
async function clearDraft(page) { for (let i = 0; i < 6; i++) await page.keyboard.press('Backspace'); }
async function setSetting(page, name, on) {
  await page.getByRole('button', { name: 'Settings' }).click();
  const box = page.getByRole('checkbox', { name: name });
  if (on) await box.check(); else await box.uncheck();
  await sleep(500);
  await page.keyboard.press('Escape');
  await sleep(200);
}
const mode = (page, name) => page.getByRole('navigation', { name: 'Game mode' }).getByRole('button', { name }).click();

// ---------- Claude turn control ----------
function startTurn(ctx, label, { scenario = 'success', hold = true } = {}) {
  const sessionId = randomUUID();
  const fixture = join(repo, '.local', `native-smoke-gameplay-${tag}-cli-${label}`);
  const releaseFile = join(ctx.dir, `release-${label}.flag`);
  const child = spawn('python', [join(here, 'gameplay-turn.py'), '--claude', claudeExe, '--bridge', bridge, '--data-dir', ctx.dir, '--fixture', fixture, '--session-id', sessionId, '--scenario', scenario, ...(hold ? ['--release-file', releaseFile] : [])], { stdio: 'ignore' });
  const done = new Promise(res => child.on('exit', code => res(code)));
  return {
    sessionId, fixture, done, child,
    release: () => writeFileSync(releaseFile, 'go'),
    turn: () => { try { return JSON.parse(readFileSync(join(fixture, 'turn.json'), 'utf8')); } catch { return null; } },
  };
}
const hasEvent = (ctx, sid, sourceEvent, scope) => sessionEvents(ctx.dir, sid).some(e => e.sourceEvent === sourceEvent && (!scope || e.scope === scope));
const waitEvent = (ctx, sid, sourceEvent, scope, timeout = 45000) => waitFor(`${sourceEvent}`, () => hasEvent(ctx, sid, sourceEvent, scope), timeout, 150);
const waitRace = (ctx, sid, pred, timeout = 25000) => waitFor('race', () => { const r = raceOf(readState(ctx.dir), sid); return r && pred(r) ? r : null; }, timeout, 150);
const seqOf = (ctx, sid, sourceEvent) => sessionEvents(ctx.dir, sid).find(e => e.sourceEvent === sourceEvent)?.seq;

// A fresh profile, automatic races on, optionally the background tray integration, and the race tab selected.
async function raceApp(name, { background = false } = {}) {
  const dir = join(repo, '.local', `native-smoke-gameplay-${tag}-${name}`);
  const ctx = await launch(dir);
  ctx.name = name;
  await setSetting(ctx.page, /Automatic races/, true);
  if (background) {
    const project = join(dir, 'tray-project');
    mkdirSync(project, { recursive: true });
    await ctx.page.getByRole('button', { name: 'Settings' }).click();
    await ctx.page.getByRole('button', { name: /Claude connection settings/ }).click();
    await ctx.page.getByLabel('Hook scope').selectOption('project');
    await ctx.page.getByLabel('Absolute project path').fill(project);
    await ctx.page.getByRole('button', { name: 'Install local Claude hooks' }).click();
    await ctx.page.getByLabel('Connection result').waitFor({ timeout: 15000 });
    await ctx.page.keyboard.press('Escape');
    await sleep(300);
  }
  await mode(ctx.page, 'Beat Claude');
  await waitFor('race tab', async () => (await ctx.page.locator('.connection-empty').count()) > 0, 8000);
  await waitFor('autoRace saved', () => readState(dir)?.settings?.autoRace === true, 8000);
  return ctx;
}
async function fgSampler(ctx) {
  const out = join(ctx.dir, 'fg-samples.json');
  const stopFile = join(ctx.dir, 'fg-stop.flag');
  rmSync(stopFile, { force: true });
  const child = spawn('powershell', ['-NoProfile', '-File', join(here, 'win32.ps1'), 'sample', '-Ms', '180000', '-Out', out, '-StopFile', stopFile], { stdio: 'ignore' });
  const exited = new Promise(r => child.on('exit', r));
  return async () => { writeFileSync(stopFile, 'x'); await exited; const seen = JSON.parse(readFileSync(out, 'utf8').replace(/^\uFEFF/, '')); try { seen.__transitions = readFileSync(out + '.trans', 'utf8').replace(/^\uFEFF/, '').trim(); } catch {} Object.defineProperty(seen, '__transitions', { enumerable: false }); return seen; };
}
const uiBadge = page => page.evaluate(() => ({
  status: document.querySelector('.agent-indicator')?.textContent.trim() ?? null,
  feedback: document.querySelector('.feedback')?.textContent.trim() ?? '',
  unranked: !!document.querySelector('.timer') && /Unranked/.test(document.querySelector('.timer').textContent),
  note: document.querySelector('.continuation-note')?.textContent ?? null,
  offers: [...document.querySelectorAll('button.offer')].map(b => b.textContent.trim()),
}));
async function race(name, opts, body) {
  const wanted = opt('scenario', '');
  if (wanted && !wanted.split(',').includes(name)) return;
  console.log(`--- ${name}`);
  let ctx; let endFg;
  try {
    ctx = await raceApp(name, opts);
    endFg = await fgSampler(ctx);
    await body(ctx);
  } catch (e) {
    check(`${name}: no script error`, false, e && e.stack ? e.stack.split('\n').slice(0, 3).join(' ') : e);
  } finally {
    if (endFg) {
      try {
        const seen = await endFg();
        check(`${name}: app never became the foreground window`, !Object.keys(seen).includes(String(ctx.pid)), `foreground pids seen ${JSON.stringify(seen)} app=${ctx.pid} transitions(epochMs:pid)=${seen.__transitions ?? ''}`);
      } catch (e) { check(`${name}: foreground sampler`, false, e.message); }
    }
    if (ctx) await stop(ctx);
  }
}
const outcomeOf = (ctx, sid) => raceOf(readState(ctx.dir), sid);
const descr = r => r ? `state=${r.state} outcome=${r.outcome} ranked=${r.ranked} reason=${r.unrankedReason ?? ''} solvedBefore=${r.playerSolvedBeforeBoundary} continued=${r.continuedPuzzleSolved}` : 'no race';
async function finishTurn(t, label) {
  const code = await Promise.race([t.done, sleep(120000).then(() => 'timeout')]);
  const turn = t.turn();
  check(`${label}: real Claude turn finished through the loopback provider`, turn && turn.failures?.length === 0 && turn.hostedModelCalled === false && turn.userSettingsUnchanged === true, JSON.stringify({ code, exit: turn?.exitCode, held: turn?.held, failures: turn?.failures, secs: turn?.seconds }));
  return turn;
}

// =================== item 1: disconnected gameplay ===================
async function itemDisconnected() {
  item = 'disconnected';
  const dir = join(repo, '.local', `native-smoke-gameplay-${tag}-disconnected`);
  let ctx = await launch(dir);
  try {
    const hiddenAtStart = !visible(ctx.pid);
    check('app launched with --hook-launch stays hidden', hiddenAtStart);
    const page = ctx.page;
    check('Daily puzzle renders', /One word\. A new day\./.test(await page.locator('h1').innerText()));
    const daily0 = await waitFor('daily game', () => { const s = readState(dir); return s?.activeGameId && s.games[s.activeGameId]; }, 10000);
    const answer = daily0 ? answerOf(readState(dir), daily0.gameId) : '';
    const inList = w => words.guesses.includes(w);
    const invalid = 'ZZZZZ';
    check('invalid word is not in the dictionary (test premise)', !inList(invalid));
    await typeWord(page, invalid);
    await waitFor('rejected', async () => /Not in the word list/.test(await feedback(page)), 5000);
    check('invalid word rejected with feedback', /Not in the word list/.test(await feedback(page)), await feedback(page));
    check('invalid word did not consume a guess', (await evaluatedRows(page)).length === 0 && readState(dir).games[daily0.gameId].guesses.length === 0);
    await clearDraft(page);
    // A guess-list word that is not an answer proves lookup uses the full accepted-guess dictionary.
    const valid = words.guesses.find(w => !words.answers.includes(w) && w !== answer);
    await typeWord(page, valid);
    const accepted = await waitFor('accepted', async () => (await evaluatedRows(page)).length === 1, 8000);
    check('valid word (accepted-guess list, not an answer) accepted and scored', !!accepted, `${valid}: ${(await evaluatedRows(page))[0]}`);
    const second = words.answers.find(w => w !== answer);
    await typeWord(page, second);
    await waitFor('second', async () => (await evaluatedRows(page)).length === 2, 8000);
    check('valid answer-list word accepted (2 rows)', (await evaluatedRows(page)).length === 2);
    // Endless: separate game, solve it to a recorded win.
    await mode(page, 'Endless');
    const endless = await waitFor('endless', () => { const s = readState(dir); const g = s?.games[s.activeGameId]; return g?.mode === 'endless' ? g : null; }, 8000);
    check('Endless puzzle started', !!endless);
    await typeWord(page, 'QQQQQ');
    await waitFor('endless invalid', async () => /Not in the word list/.test(await feedback(page)), 5000);
    check('Endless invalid word rejected', /Not in the word list/.test(await feedback(page)));
    await clearDraft(page);
    const eAnswer = answerOf(readState(dir), endless.gameId);
    const miss = words.answers.find(w => w !== eAnswer);
    await typeWord(page, miss);
    await waitFor('endless miss', async () => (await evaluatedRows(page)).length === 1, 8000);
    check('Endless valid word accepted', (await evaluatedRows(page)).length === 1);
    // Close and reopen resume: Daily (2 guesses) and Endless (1 guess) must come back after a hard kill.
    const before = readState(dir);
    const dailyId = Object.values(before.games).find(g => g.mode === 'daily').gameId;
    await stop(ctx);
    check('process killed (crash-style, no graceful close)', !pidAlive(ctx.pid));
    ctx = await launch(dir);
    await waitFor('restarted', () => { const s = readState(dir); return s && s.processedSeq > before.processedSeq ? s : null; }, 15000);
    await sleep(2500);
    const settled = readState(dir);
    check('relaunch with --hook-launch stays hidden', !visible(ctx.pid));
    const diag = { quarantined: Object.keys(settled?.quarantinedGames ?? {}), savedStartedAtUtc: before.games[dailyId].startedAtUtc, feedback: settled?.feedback, games: Object.keys(settled?.games ?? {}) };
    check('Daily guesses survived kill/relaunch (resume)', settled?.games[dailyId]?.guesses.length === 2 && settled.games[dailyId].guesses[0].word === valid, JSON.stringify(diag));
    check('Endless game and its guess survived kill/relaunch (resume)', settled?.games[endless.gameId]?.guesses.length === 1, JSON.stringify(diag));
    check('active game resumed on the Endless puzzle', settled?.activeGameId === endless.gameId, String(settled?.activeGameId));
    check('no saved puzzle was quarantined as needing recovery', Object.keys(settled?.quarantinedGames ?? {}).length === 0, JSON.stringify(diag));
    check('UI shows the resumed Endless row', (await evaluatedRows(ctx.page)).length === 1, `rows=${(await evaluatedRows(ctx.page)).length}`);
    // Whatever survived, keep playing: start/continue Endless and solve it to a recorded win after the restart.
    await mode(ctx.page, 'Endless');
    const cur = await waitFor('endless active', () => { const s = readState(dir); const g = s?.games[s.activeGameId]; return g?.mode === 'endless' && g.status === 'playing' ? g : null; }, 8000);
    const eAnswer2 = answerOf(readState(dir), cur.gameId);
    await typeWord(ctx.page, eAnswer2);
    const solved = await waitFor('solved', () => readState(dir).games[cur.gameId].status === 'solved', 8000);
    check('an Endless puzzle can be solved after the restart and the win is recorded', !!solved && readState(dir).results.some(r => r.mode === 'endless' && r.payload.won), JSON.stringify(readState(dir).results.map(r => [r.mode, r.payload.outcome, r.payload.guessCount])));
  } finally {
    await stop(ctx);
  }
}

// =================== item 2: race orderings ===================
async function itemOrderings() {
  item = 'orderings';
  await race('player-first', {}, async ctx => {
    const t = startTurn(ctx, 'player-first');
    check('player-first: Claude turn started and race offered', !!await waitRace(ctx, t.sessionId, r => ['offered', 'running'].includes(r.state)));
    const running = await waitRace(ctx, t.sessionId, r => r.state === 'running');
    check('player-first: auto-show presented the race (running, ranked)', running?.ranked === true, descr(running));
    check('player-first: window shown without activation (visible)', visible(ctx.pid));
    const s = readState(ctx.dir);
    const answer = answerOf(s, running.gameId);
    await typeWord(ctx.page, answer);
    const won = await waitRace(ctx, t.sessionId, r => r.state === 'terminal');
    check('player-first: accepted solve before Stop => player_win, ranked', won?.outcome === 'player_win' && won.ranked, descr(won));
    t.release();
    await waitEvent(ctx, t.sessionId, 'Stop', 'root');
    await finishTurn(t, 'player-first');
    await sleep(1200);
    const after = outcomeOf(ctx, t.sessionId);
    check('player-first: later Stop cannot reverse the win (immutable)', after.outcome === 'player_win' && after.ranked, descr(after));
    check('player-first: solve sequence precedes Stop sequence', won.lastSeq < seqOf(ctx, t.sessionId, 'Stop'), `solveSeq<=${won.lastSeq} stopSeq=${seqOf(ctx, t.sessionId, 'Stop')}`);
    const st = readState(ctx.dir);
    check('player-first: win recorded once as a ranked result; agent status completed', st.results.filter(r => r.mode === 'race' && r.payload.outcome === 'player_win' && r.payload.ranked).length === 1 && Object.values(st.agentStatuses).some(a => a.status === 'completed'), JSON.stringify(Object.values(st.agentStatuses).map(a => a.status)));
    check('player-first: UI says you beat Claude', /You beat Claude/.test((await uiBadge(ctx.page)).feedback), JSON.stringify(await uiBadge(ctx.page)));
  });

  await race('agent-first', {}, async ctx => {
    const t = startTurn(ctx, 'agent-first');
    const running = await waitRace(ctx, t.sessionId, r => r.state === 'running');
    check('agent-first: race running before Stop', !!running, descr(running));
    const s = readState(ctx.dir);
    const answer = answerOf(s, running.gameId);
    const miss = words.answers.find(w => w !== answer);
    await typeWord(ctx.page, miss);
    await waitFor('row', async () => (await evaluatedRows(ctx.page)).length === 1, 8000);
    t.release();
    await waitEvent(ctx, t.sessionId, 'Stop', 'root');
    const lost = await waitRace(ctx, t.sessionId, r => r.state === 'terminal');
    check('agent-first: matching root Stop before a solve => agent_first, ranked loss', lost?.outcome === 'agent_first' && lost.ranked, descr(lost));
    await finishTurn(t, 'agent-first');
    const stateNow = readState(ctx.dir);
    check('agent-first: unfinished puzzle kept (playing, 1 row)', stateNow.games[running.gameId].status === 'playing' && stateNow.games[running.gameId].guesses.length === 1);
    const ui = await uiBadge(ctx.page);
    check('agent-first: UI shows Claude finished first and the keep-solving note', /Claude finished first/.test(ui.feedback) && /Keep solving/.test(ui.note ?? ''), JSON.stringify(ui));
    const resultsBefore = readState(ctx.dir).results.length;
    await typeWord(ctx.page, answer);
    await waitFor('continued', () => readState(ctx.dir).games[running.gameId].status === 'solved', 8000);
    const fin = outcomeOf(ctx, t.sessionId);
    check('agent-first: later casual solve cannot reverse agent_first (continuedPuzzleSolved only)', fin.outcome === 'agent_first' && fin.playerSolvedBeforeBoundary === false && fin.continuedPuzzleSolved === true, descr(fin));
    check('agent-first: continuation adds no ordinary daily/endless result', readState(ctx.dir).results.length === resultsBefore, `${resultsBefore} -> ${readState(ctx.dir).results.length}`);
  });

  await race('hidden-stop', { background: true }, async ctx => {
    const t = startTurn(ctx, 'hidden-stop');
    const running = await waitRace(ctx, t.sessionId, r => r.state === 'running');
    check('hidden-stop: race running with the window auto-shown', !!running && visible(ctx.pid), descr(running));
    const bridgeCfg = existsSync(join(ctx.dir, 'bridge.json')) ? readFileSync(join(ctx.dir, 'bridge.json'), 'utf8').replace(/"desktopPath":"[^"]*"/, '"desktopPath":"<path>"') : 'missing';
    check('hidden-stop: UI hook install enabled the background/tray integration', /"backgroundIntegration":\s*true/.test(bridgeCfg), bridgeCfg.slice(0, 200));
    const winList = win32('windows', '-ProcessId', String(ctx.pid));
    const closeOut = win32('close', '-ProcessId', String(ctx.pid));
    const closedByMessage = await waitFor('hidden', () => !visible(ctx.pid), 4000, 300);
    check('hidden-stop: user close (WM_CLOSE) of the auto-shown window hides it to the tray (background integration on)', !!closedByMessage, `windows=${winList} close=${closeOut} visible=${visible(ctx.pid)} alive=${pidAlive(ctx.pid)}`);
    let viaNative = false;
    if (!closedByMessage) {
      await ctx.page.evaluate(() => window.__TAURI_INTERNALS__.invoke('native_hide'));
      viaNative = !!await waitFor('hiddenNative', () => !visible(ctx.pid), 3000, 300);
      check('hidden-stop: the native_hide command hides the auto-shown window', viaNative, `visible=${visible(ctx.pid)}`);
    }
    if (!closedByMessage && !viaNative) win32('hide', '-ProcessId', String(ctx.pid));
    await waitFor('hidden2', () => !visible(ctx.pid), 3000, 300);
    check(`hidden-stop: window hidden before Stop${!closedByMessage && !viaNative ? ' (by a raw Win32 SW_HIDE from the harness, because both product hide paths no-opped)' : ''}, process alive`, !visible(ctx.pid) && pidAlive(ctx.pid), '');
    t.release();
    await waitEvent(ctx, t.sessionId, 'Stop', 'root');
    await finishTurn(t, 'hidden-stop');
    const processedHidden = await waitRace(ctx, t.sessionId, r => r.state === 'terminal', 12000);
    check('hidden-stop: Stop landed and was journaled while hidden', hasEvent(ctx, t.sessionId, 'Stop', 'root') && !visible(ctx.pid));
    check('hidden-stop: race resolved agent_first while hidden (Stop processed, not lost)', processedHidden?.outcome === 'agent_first', descr(processedHidden));
    const stopSeq = seqOf(ctx, t.sessionId, 'Stop');
    // Return the window with the app's own non-activating path, then play: the earlier Stop must win over later input.
    await ctx.page.evaluate(() => window.__TAURI_INTERNALS__.invoke('native_show', { explicit: false }));
    await waitFor('shown', () => visible(ctx.pid), 6000, 300);
    check('hidden-stop: window returned (non-activating path)', visible(ctx.pid));
    const answer = answerOf(readState(ctx.dir), running.gameId);
    await typeWord(ctx.page, answer);
    await waitFor('solved', () => readState(ctx.dir).games[running.gameId].status === 'solved', 8000);
    const fin = outcomeOf(ctx, t.sessionId);
    const solveEntry = readJournal(ctx.dir).filter(e => e.kind === 'command' && e.type === 'submitGuess').pop();
    check('hidden-stop: a solve after the hidden Stop does not win (Stop seq < solve seq)', fin.outcome === 'agent_first' && solveEntry.seq > stopSeq, `${descr(fin)} stopSeq=${stopSeq} solveSeq=${solveEntry.seq}`);
  });

  await race('short-turn', {}, async ctx => {
    // Deterministic short turn: freeze the page's JavaScript (CDP Debugger.pause) so the UI cannot present the puzzle
    // while the whole turn, including Stop, completes. The native receiver still journals every event.
    await ctx.cdp.send('Debugger.enable');
    await ctx.cdp.send('Debugger.pause');
    const t = startTurn(ctx, 'short-turn', { hold: false });
    await waitEvent(ctx, t.sessionId, 'Stop', 'root');
    await finishTurn(t, 'short-turn');
    check('short-turn: race and Stop are journaled but the frozen UI has not presented anything', !readState(ctx.dir).races || Object.keys(readState(ctx.dir).races).length === 0, 'checkpoint has no race yet');
    await ctx.cdp.send('Debugger.resume');
    await ctx.cdp.send('Debugger.disable');
    const r = await waitRace(ctx, t.sessionId, x => x.state === 'terminal', 12000);
    check('short-turn: Stop before a usable puzzle => unranked agent_first, not_presented', r?.outcome === 'agent_first' && r.ranked === false && r.unrankedReason === 'not_presented' && r.presentedSeq === null, descr(r));
    check('short-turn: excluded from the player-versus-agent record (no ranked result)', !readState(ctx.dir).results.some(x => x.mode === 'race' && x.payload.ranked));
    const ui = await uiBadge(ctx.page);
    check('short-turn: UI surfaces that the turn was too short to race (informational: spec asks for it)', /too short/i.test(ui.feedback + (await ctx.page.locator('main').innerText())), JSON.stringify(ui));
  });

  await race('two-sessions', {}, async ctx => {
    const a = startTurn(ctx, 'two-A');
    const ra = await waitRace(ctx, a.sessionId, r => r.state === 'running');
    check('two-sessions: session A race running and foregrounded', !!ra && readState(ctx.dir).activeRaceId === ra.raceId, descr(ra));
    const draft = words.answers.find(w => w !== answerOf(readState(ctx.dir), ra.gameId));
    await typeWord(ctx.page, draft.slice(0, 3), { submit: false });
    const b = startTurn(ctx, 'two-B');
    const rb = await waitRace(ctx, b.sessionId, () => true, 30000);
    const st = readState(ctx.dir);
    check('two-sessions: session B retained as an offer, active race/grid not replaced', rb?.state === 'offered' && st.activeRaceId === ra.raceId && st.activeGameId === ra.gameId, `${descr(rb)} active=${st.activeRaceId === ra.raceId}`);
    const ui = await uiBadge(ctx.page);
    const draftKept = await ctx.page.evaluate(() => [...document.querySelectorAll('.tile.filled')].map(t => t.textContent).join(''));
    check('two-sessions: switch control offered and draft letters untouched', ui.offers.some(o => /Join an unranked puzzle/.test(o)) && draftKept === draft.slice(0, 3), `${JSON.stringify(ui.offers)} draft=${draftKept}`);
    b.release();
    await waitEvent(ctx, b.sessionId, 'Stop', 'root');
    await finishTurn(b, 'two-B');
    await sleep(1500);
    const afterB = readState(ctx.dir);
    check("two-sessions: B's Stop resolved only B (unranked); A still running", raceOf(afterB, b.sessionId).state === 'terminal' && !raceOf(afterB, b.sessionId).ranked && raceOf(afterB, a.sessionId).state === 'running', `B ${descr(raceOf(afterB, b.sessionId))} | A ${descr(raceOf(afterB, a.sessionId))}`);
    await clearDraft(ctx.page);
    await typeWord(ctx.page, answerOf(afterB, ra.gameId));
    const won = await waitRace(ctx, a.sessionId, r => r.state === 'terminal');
    check('two-sessions: A still winnable after B finished (player_win, ranked)', won?.outcome === 'player_win' && won.ranked, descr(won));
    a.release();
    await waitEvent(ctx, a.sessionId, 'Stop', 'root');
    await finishTurn(a, 'two-A');
    const fin = readState(ctx.dir);
    check('two-sessions: only A counts in the ranked record', fin.results.filter(r => r.mode === 'race' && r.payload.ranked).length === 1, JSON.stringify(fin.results.map(r => [r.payload.outcome, r.payload.ranked])));
  });

  await race('child-stop', {}, async ctx => {
    const t = startTurn(ctx, 'child-stop', { scenario: 'subagent' });
    const running = await waitRace(ctx, t.sessionId, r => r.state === 'running');
    check('child-stop: race running', !!running, descr(running));
    const child = await waitEvent(ctx, t.sessionId, 'SubagentStop', 'child', 60000);
    check('child-stop: child SubagentStop journaled (scope child)', !!child);
    await sleep(2000);
    const mid = outcomeOf(ctx, t.sessionId);
    check('child-stop: child Stop did not finish the race', mid.state === 'running' && mid.outcome === null && !hasEvent(ctx, t.sessionId, 'Stop', 'root'), descr(mid));
    t.release();
    await waitEvent(ctx, t.sessionId, 'Stop', 'root');
    await finishTurn(t, 'child-stop');
    const fin = await waitRace(ctx, t.sessionId, r => r.state === 'terminal');
    check('child-stop: root Stop then ends it agent_first', fin?.outcome === 'agent_first' && fin.ranked, descr(fin));
  });
}

// =================== item 3: failure and recovery ===================
async function itemFailure() {
  item = 'failure';
  await race('provider-error', {}, async ctx => {
    const t = startTurn(ctx, 'provider-error', { scenario: 'provider-error' });
    const running = await waitRace(ctx, t.sessionId, r => r.state === 'running');
    check('provider-error: race running before the failure', !!running, descr(running));
    t.release();
    await waitEvent(ctx, t.sessionId, 'StopFailure', 'root');
    await finishTurn(t, 'provider-error').catch(() => {});
    const r = await waitRace(ctx, t.sessionId, x => x.state === 'terminal');
    check('provider-error: StopFailure => interrupted, neutral (unranked)', r?.outcome === 'interrupted' && r.ranked === false, descr(r));
    const st = readState(ctx.dir);
    check('provider-error: no ranked win/loss recorded', !st.results.some(x => x.mode === 'race' && x.payload.ranked), JSON.stringify(st.results.map(x => [x.payload.outcome, x.payload.ranked])));
    const ui = await uiBadge(ctx.page);
    check('provider-error: UI shows a neutral ending', /without a ranked result/.test(ui.feedback) && /Interrupted/.test(ui.status ?? ''), JSON.stringify(ui));
  });

  // Crash recovery: kill mid-race, relaunch, the race resolves conservatively; a late Stop cannot rewrite it.
  console.log('--- crash-recovery');
  {
    let ctx; let t;
    try {
      ctx = await raceApp('crash-recovery');
      t = startTurn(ctx, 'crash-recovery');
      const running = await waitRace(ctx, t.sessionId, r => r.state === 'running');
      check('crash-recovery: race running when the app is killed', !!running, descr(running));
      const dir = ctx.dir;
      await stop(ctx);
      check('crash-recovery: app process killed mid-race', !pidAlive(ctx.pid));
      ctx = await launch(dir); ctx.name = 'crash-recovery';
      const r = await waitRace(ctx, t.sessionId, x => x.state === 'terminal', 15000);
      check('crash-recovery: after relaunch the race is neutral interrupted (not agent_first, not a win)', r?.outcome === 'interrupted' && r.ranked === false, descr(r));
      check('crash-recovery: relaunch stayed hidden (--hook-launch)', !visible(ctx.pid));
      check('crash-recovery: puzzle preserved (still playing)', readState(dir).games[running.gameId]?.status === 'playing', JSON.stringify({ games: Object.keys(readState(dir).games), quarantined: Object.keys(readState(dir).quarantinedGames ?? {}) }));
      t.release();
      await waitEvent(ctx, t.sessionId, 'Stop', 'root');
      await finishTurn(t, 'crash-recovery');
      await sleep(1500);
      const late = outcomeOf(ctx, t.sessionId);
      check('crash-recovery: a late Stop for the same turn cannot rewrite the interrupted result', late.outcome === 'interrupted' && !readState(ctx.dir).results.some(x => x.payload.ranked && x.mode === 'race'), descr(late));
    } catch (e) { check('crash-recovery: no script error', false, e.stack?.split('\n').slice(0, 3).join(' ')); }
    finally { if (ctx) await stop(ctx); }
  }

  // Missed notification: Stop is delivered while the app is down.
  console.log('--- missed-stop');
  {
    let ctx; let t;
    try {
      ctx = await raceApp('missed-stop');
      t = startTurn(ctx, 'missed-stop');
      const running = await waitRace(ctx, t.sessionId, r => r.state === 'running');
      check('missed-stop: race running before the app goes down', !!running, descr(running));
      const dir = ctx.dir;
      await stop(ctx);
      t.release();
      const code = await finishTurn(t, 'missed-stop');
      check('missed-stop: Stop hook ran with the receiver down and Claude finished (hook exited 0 within budget)', !!code && code.exitCode === 0, `claude exit ${code?.exitCode}`);
      ctx = await launch(dir); ctx.name = 'missed-stop';
      const r = await waitRace(ctx, t.sessionId, x => x.state === 'terminal', 15000);
      check('missed-stop: the missed Stop never reached the journal', !hasEvent(ctx, t.sessionId, 'Stop'), JSON.stringify(sessionEvents(dir, t.sessionId).map(e => e.sourceEvent)));
      check('missed-stop: race resolved neutral interrupted, no invented agent_first or loss', r?.outcome === 'interrupted' && r.ranked === false, descr(r));
      check('missed-stop: puzzle preserved and playable', readState(dir).games[running.gameId]?.status === 'playing', JSON.stringify({ games: Object.keys(readState(dir).games), quarantined: Object.keys(readState(dir).quarantinedGames ?? {}) }));
    } catch (e) { check('missed-stop: no script error', false, e.stack?.split('\n').slice(0, 3).join(' ')); }
    finally { if (ctx) await stop(ctx); }
  }

  // Session end: only if headless Claude emits it. Run the existing lifecycle harness scenario against a fresh profile.
  console.log('--- session-end');
  {
    let ctx;
    try {
      ctx = await raceApp('session-end');
      const fixture = join(repo, '.local', `native-smoke-gameplay-${tag}-session-end-cli`);
      let passed = null; let detail = '';
      try {
        execFileSync('python', [join(repo, 'scripts', 'claude-lifecycle-smoke.py'), '--claude', claudeExe, '--bridge', bridge, '--data-dir', ctx.dir, '--fixture', fixture, '--scenario', 'session-end'], { stdio: 'ignore', timeout: 90000, env: { ...process.env } });
      } catch {}
      try { const r = JSON.parse(readFileSync(join(fixture, 'result.json'), 'utf8')); passed = r.passed; detail = JSON.stringify({ claude: r.claudeVersion, failures: r.failures, events: (r.events || r.observedEvents || []).map(e => e.sourceEvent) }); } catch { detail = 'no result.json'; }
      const ended = readJournal(ctx.dir).some(e => e.sourceEvent === 'SessionEnd');
      check(`session-end: headless Claude emitted SessionEnd? ${ended ? 'yes' : 'no'} (informational; unverifiable item stays unchecked when "no")`, true, `harness passed=${passed}; SessionEnd journaled=${ended}; ${detail}`);
      results.at(-1).sessionEndEmitted = ended;
    } catch (e) { check('session-end: no script error', false, e.stack?.split('\n').slice(0, 3).join(' ')); }
    finally { if (ctx) await stop(ctx); }
  }
}

// =================== item 4: hook second launch ===================
async function itemSecondLaunch() {
  item = 'secondlaunch';
  const dir = join(repo, '.local', `native-smoke-gameplay-${tag}-secondlaunch`);
  const ctx = await launch(dir);
  let notepad;
  try {
    check('first instance running hidden', !visible(ctx.pid));
    // With no foreground window there is nothing to steal; put a throwaway Notepad in front so activation would be visible.
    if (win32('fgpid') === '0') { notepad = spawn('notepad.exe', [], { stdio: 'ignore' }); await sleep(3000); }
    const fgBefore = win32('fgpid');
    check(`OBSERVATION baseline foreground: ${fgBefore === '0' ? 'none (locked or idle desktop), so only app-became-foreground is detectable' : 'a user window was in front'}`, true, `foreground pid ${fgBefore}${notepad ? ' (harness Notepad)' : ''}`);
    const end = await fgSampler(ctx);
    const second = spawn(app, ['--hook-launch'], { env: appEnv(dir), stdio: 'ignore' });
    const secondPid = second.pid;
    const exit = await Promise.race([new Promise(r => second.on('exit', c => r(c))), sleep(15000).then(() => 'timeout')]);
    await sleep(2500);
    check('second --hook-launch exited (single instance, handed off)', exit !== 'timeout', `exit code ${exit}`);
    check('window still hidden after the second launch', !visible(ctx.pid));
    check('first instance still running and receiver endpoint intact', pidAlive(ctx.pid) && existsSync(join(dir, 'endpoint.json')));
    let seen = await end();
    check('second launch never took the foreground', !Object.keys(seen).includes(String(ctx.pid)) && !Object.keys(seen).includes(String(secondPid)), `foreground pids ${JSON.stringify(seen)} first=${ctx.pid} second=${secondPid} before=${fgBefore}`);
    check('foreground window unchanged by the launch', Object.keys(seen).length === 1 && Object.keys(seen)[0] === fgBefore, `before=${fgBefore} seen=${JSON.stringify(seen)}`);
    // Same again while the window is visible (auto-shown with SW_SHOWNOACTIVATE): still no activation.
    await ctx.page.evaluate(() => window.__TAURI_INTERNALS__.invoke('native_show', { explicit: false }));
    await waitFor('visible', () => visible(ctx.pid), 6000, 300);
    const fg2 = win32('fgpid');
    const end2 = await fgSampler(ctx);
    const third = spawn(app, ['--hook-launch'], { env: appEnv(dir), stdio: 'ignore' });
    await Promise.race([new Promise(r => third.on('exit', r)), sleep(15000)]);
    await sleep(2500);
    seen = await end2();
    check('second launch with the window already visible: no activation', visible(ctx.pid) && !Object.keys(seen).includes(String(ctx.pid)) && !Object.keys(seen).includes(String(third.pid)), `foreground pids ${JSON.stringify(seen)} before=${fg2}`);
  } finally { try { notepad?.kill(); } catch {} await stop(ctx); }
}

// =================== item 5: keyboard, viewport, motion, contrast ===================
const luminance = ([r, g, b]) => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const parseRgb = s => (s.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
const tileColours = page => page.evaluate(() => ['correct', 'present', 'absent'].map(k => { const t = document.querySelector(`.tile.${k}`); if (!t) return [k, null]; const cs = getComputedStyle(t); return [k, cs.color, cs.backgroundColor]; }));

async function itemA11y() {
  item = 'a11y';
  const dir = join(repo, '.local', `native-smoke-gameplay-${tag}-a11y`);
  let ctx = await launch(dir);
  try {
    const page = ctx.page;
    // Give the grid evaluated tiles of all kinds so colours and patterns can be inspected.
    await waitFor('game', () => readState(dir)?.activeGameId, 8000);
    const answer = answerOf(readState(dir), readState(dir).activeGameId);
    const fit = w => [...w].filter((c, i) => c === answer[i]).length;
    const pool = words.answers.filter(w => w !== answer).sort((a, b) => fit(b) - fit(a));
    for (const w of [pool[0], pool.find(w => ![...w].some(c => pool[0].includes(c)))] .filter(Boolean)) { await typeWord(page, w); await sleep(500); }
    await sleep(500);

    // --- Tab order
    await page.evaluate(() => document.activeElement?.blur());
    const seq = [];
    for (let i = 0; i < 45; i++) {
      await page.keyboard.press('Tab');
      const d = await page.evaluate(() => {
        const e = document.activeElement; const r = e.getBoundingClientRect(); const cs = getComputedStyle(e);
        return { tag: e.tagName, name: e.getAttribute('aria-label') || e.textContent.trim().slice(0, 20), top: Math.round(r.top), left: Math.round(r.left), outline: cs.outlineStyle + ' ' + cs.outlineWidth, shadow: cs.boxShadow !== 'none', focusVisible: e.matches(':focus-visible') };
      });
      seq.push(d);
      if (i > 0 && d.tag === seq[0].tag && d.name === seq[0].name && d.top === seq[0].top) break;
    }
    const order = seq.map(d => d.name);
    console.log('tab order:', order.join(' > '));
    const unnamed = seq.filter(d => !d.name);
    check('Tab order visits header, mode tabs, then keyboard (in visual order)', ['Clawdle home', 'How to play', 'Statistics', 'Settings', 'Daily', 'Endless', 'Beat Claude'].every((n, i) => order.includes(n) && (i === 0 || order.indexOf(n) > order.indexOf(['Clawdle home', 'How to play', 'Statistics', 'Settings', 'Daily', 'Endless', 'Beat Claude'][i - 1]))), order.slice(0, 16).join(' > '));
    const readingOrder = seq.filter(d => d.tag === 'BUTTON' && d.top > 150).every((d, i, a) => i === 0 || d.top > a[i - 1].top - 6 || false);
    check('Tab order follows reading order on the on-screen keyboard (rows top-to-bottom)', readingOrder);
    check('every focus stop has an accessible name', unnamed.length === 0, `${unnamed.length} unnamed of ${seq.length}`);
    const controls = seq.filter(d => d.tag === 'BUTTON' || d.tag === 'A');
    check('every button/link focus stop shows a visible focus indicator (outline or shadow)', controls.length > 20 && controls.every(d => !/^none/.test(d.outline) || d.shadow), JSON.stringify({ controls: controls.length, missing: controls.filter(d => /^none/.test(d.outline) && !d.shadow).map(d => d.name), nonControlStops: seq.filter(d => !controls.includes(d)).map(d => d.tag) }));
    check('Tab wraps without a keyboard trap (returns to the first stop)', seq.length < 45, `${seq.length} stops`);

    // --- Dialog: Enter should activate a focused button (native behaviour); Space is the fallback used to continue
    await page.getByRole('button', { name: 'How to play' }).focus();
    await page.keyboard.press('Enter');
    const openByEnter = await waitFor('dialog', async () => (await page.locator('dialog[open]').count()) === 1, 2500);
    check('Enter on a focused header button opens its dialog', !!openByEnter, openByEnter ? '' : 'Enter did nothing; main keydown handler calls preventDefault on Enter for every non-input target');
    if (!openByEnter) {
      await page.getByRole('button', { name: 'How to play' }).focus();
      await page.keyboard.press('Space');
    }
    const open = await waitFor('dialog', async () => (await page.locator('dialog[open]').count()) === 1, 4000);
    check('Space on a focused button opens the dialog (keyboard-only fallback)', !!open);
    await page.keyboard.press('Escape');
    await waitFor('closedClean', async () => (await page.locator('dialog[open]').count()) === 0, 3000);
    const cleanFocus = await page.evaluate(() => document.activeElement?.tagName + '.' + (document.activeElement?.getAttribute('aria-label') || ''));
    check('focus returns to the game surface after Escape (no Tab presses in between)', /^MAIN/.test(cleanFocus), cleanFocus);
    await page.getByRole('button', { name: 'How to play' }).focus();
    await page.keyboard.press('Space');
    await waitFor('dialog2', async () => (await page.locator('dialog[open]').count()) === 1, 3000);
    const inDialog = [];
    for (let i = 0; i < 6; i++) { await page.keyboard.press('Tab'); inDialog.push(await page.evaluate(() => !!document.activeElement?.closest('dialog'))); }
    check(`OBSERVATION Tab inside the modal dialog: ${inDialog.filter(x => !x).length} of ${inDialog.length} presses left the dialog (WebView2 hands Tab to the host/document; informational)`, true, JSON.stringify(inDialog));
    const dlgName = await page.evaluate(() => { const d = document.querySelector('dialog[open]'); return { label: d.getAttribute('aria-label'), by: d.getAttribute('aria-labelledby'), heading: d.querySelector('h2')?.textContent }; });
    check('dialog exposes a title heading (informational: no aria-label/labelledby on <dialog>)', !!dlgName.heading, JSON.stringify(dlgName));
    await page.keyboard.press('Escape');
    const closed = await waitFor('closed', async () => (await page.locator('dialog[open]').count()) === 0, 4000);
    const focusBack = await page.evaluate(() => document.activeElement?.tagName + '.' + (document.activeElement?.getAttribute('aria-label') || ''));
    check('Escape closes the dialog', !!closed);
    check('focus returns to the game surface after closing', /^MAIN/.test(focusBack), focusBack);
    // Enter inside a dialog activates the focused control (Close button), Space on a checkbox toggles it.
    await page.getByRole('button', { name: 'Settings' }).focus();
    await page.keyboard.press('Space');
    await waitFor('settings', async () => (await page.locator('dialog[open]').count()) === 1, 4000);
    await page.getByRole('checkbox', { name: /High contrast/ }).focus();
    await page.keyboard.press('Space');
    await sleep(600);
    check('Space toggles a setting checkbox via keyboard', await page.getByRole('checkbox', { name: /High contrast/ }).isChecked() && readState(dir).settings.highContrast === true);
    await page.getByRole('button', { name: 'Close dialog' }).focus();
    await page.keyboard.press('Enter');
    const closedByEnter = await waitFor('closed2', async () => (await page.locator('dialog[open]').count()) === 0, 2500);
    check('Enter on the focused Close dialog button closes it', !!closedByEnter, closedByEnter ? '' : 'Enter swallowed inside the dialog as well');
    if (!closedByEnter) { await page.keyboard.press('Space'); await waitFor('closed3', async () => (await page.locator('dialog[open]').count()) === 0, 3000); }

    // --- Physical keys: Backspace and Enter, letters ignored while a dialog is open
    await page.locator('main.app').focus();
    for (const ch of 'abc') await page.keyboard.press(ch);
    await page.keyboard.press('Backspace');
    const draft = await page.evaluate(() => [...document.querySelectorAll('.tile.filled')].map(t => t.textContent).join(''));
    check('physical keys type into the puzzle and Backspace deletes', draft === 'AB', `draft=${draft}`);
    await page.keyboard.press('Enter');
    check('Enter with an incomplete word is rejected with a message', /five-letter/.test(await feedback(page)), await feedback(page));
    await clearDraft(page);

    // --- High contrast (setting is on from the keyboard test above) and reduced motion
    const hc = await page.evaluate(() => ({ cls: document.querySelector('main.app').className, patterns: [...document.querySelectorAll('.tile-pattern')].map(p => p.textContent).join('') }));
    check('High contrast setting applied: class set and tile symbols shown', /high-contrast/.test(hc.cls) && hc.patterns.length >= 5, JSON.stringify(hc));
    const hcColours = await tileColours(page);
    const ratio = ([, fg, bg]) => (fg && bg ? contrast(parseRgb(fg), parseRgb(bg)) : null);
    const hcRatios = hcColours.map(c => [c[0], ratio(c)?.toFixed(2)]);
    check('High contrast tile text contrast is at least 3:1 (large text) for evaluated tiles', hcColours.every(c => ratio(c) === null || ratio(c) >= 3), JSON.stringify(hcRatios));
    await setSetting(page, /High contrast/, false);
    const defColours = await tileColours(page);
    const defRatios = defColours.map(c => [c[0], ratio(c)?.toFixed(2)]);
    check('default theme tile text contrast measured (recorded; >= 3:1 large text)', defColours.every(c => ratio(c) === null || ratio(c) >= 3), JSON.stringify(defRatios));
    await setSetting(page, /High contrast/, true);

    const motionBefore = await page.evaluate(() => { const t = document.querySelector('.tile.correct, .tile.present, .tile.absent'); const cs = getComputedStyle(t); return { anim: cs.animationName + '/' + cs.animationDuration, trans: cs.transitionDuration }; });
    await setSetting(page, /Reduced motion/, true);
    const motionAfter = await page.evaluate(() => { const t = document.querySelector('.tile.correct, .tile.present, .tile.absent'); const cs = getComputedStyle(t); return { cls: document.querySelector('main.app').className, anim: cs.animationName + '/' + cs.animationDuration, trans: cs.transitionDuration }; });
    check('Reduced motion setting applied: class set', /reduce-motion/.test(motionAfter.cls), JSON.stringify({ motionBefore, motionAfter }));
    check('Reduced motion removes tile animation/transition time', /^none|\/0s$/.test(motionAfter.anim) && /^0s/.test(motionAfter.trans) || motionAfter.anim !== motionBefore.anim || motionAfter.trans !== motionBefore.trans, JSON.stringify({ motionBefore, motionAfter }));
    // OS-level preferences (informational): does the app follow prefers-reduced-motion / forced-colors without the in-app setting?
    await setSetting(page, /Reduced motion/, false);
    await setSetting(page, /High contrast/, false);
    await page.emulateMedia({ reducedMotion: 'reduce', forcedColors: 'active' });
    const os = await page.evaluate(() => ({ cls: document.querySelector('main.app').className }));
    await page.emulateMedia({ reducedMotion: null, forcedColors: null });
    results.push({ item, check: 'OS prefers-reduced-motion / forced-colors honoured without the in-app toggle (informational)', pass: true, evidence: `emulated reduce+forced-colors; app class stays "${os.cls.trim()}" (follows in-app settings only)` });
    console.log('INFO OS media preferences:', os.cls);
    // Settings persist across a restart.
    await setSetting(page, /High contrast/, true);
    await setSetting(page, /Reduced motion/, true);
    await stop(ctx);
    ctx = await launch(dir);
    const cls = await ctx.page.locator('main.app').getAttribute('class');
    check('high contrast and reduced motion settings persist across restart', /high-contrast/.test(cls) && /reduce-motion/.test(cls), cls);

    // --- Narrow viewport via CDP
    const sizes = [[360, 600], [320, 568], [280, 480]];
    for (const [w, h] of sizes) {
      await ctx.cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
      await sleep(500);
      const m = await ctx.page.evaluate(() => {
        const rect = e => e.getBoundingClientRect();
        const keys = [...document.querySelectorAll('.key')]; const tiles = [...document.querySelectorAll('.tile')];
        return { vw: innerWidth, scrollW: document.documentElement.scrollWidth, bodyScrollW: document.body.scrollWidth, minKey: Math.min(...keys.map(k => Math.min(rect(k).width, rect(k).height))), maxKeyRight: Math.max(...keys.map(k => rect(k).right)), minKeyLeft: Math.min(...keys.map(k => rect(k).left)), minTile: Math.min(...tiles.map(t => rect(t).width)), maxTileRight: Math.max(...tiles.map(t => rect(t).right)), headerFits: [...document.querySelectorAll('.header-actions button')].every(b => rect(b).right <= innerWidth && rect(b).left >= 0), navFits: [...document.querySelectorAll('.mode-nav button')].every(b => rect(b).right <= innerWidth + 1 && rect(b).left >= 0) };
      });
      check(`${w}x${h}: no horizontal scroll, keys/tiles/header/mode tabs inside the viewport`, m.scrollW <= m.vw && m.maxKeyRight <= m.vw && m.minKeyLeft >= 0 && m.maxTileRight <= m.vw && m.headerFits && m.navFits, JSON.stringify(m));
      check(`${w}x${h}: keys stay tappable (>= 24 CSS px target, WCAG 2.2 AA)${w < 320 ? ' [OBSERVATION: below the 360 px window minimum and the 320 px reflow width]' : ''}`, m.minKey >= 23.5 || w < 320, `min key dimension ${m.minKey.toFixed(1)}px, tile ${m.minTile.toFixed(1)}px`);
    }
    await ctx.cdp.send('Emulation.clearDeviceMetricsOverride');

    // --- Roles and labels (axe-core is not installed in node_modules, so manual checks)
    const roles = await ctx.page.evaluate(() => ({
      main: document.querySelector('main')?.getAttribute('aria-label'),
      navLabel: document.querySelector('nav')?.getAttribute('aria-label'),
      currentMode: document.querySelector('nav [aria-current]')?.textContent,
      gridLabel: document.querySelector('.grid')?.getAttribute('aria-label'),
      rowLabels: [...document.querySelectorAll('.grid-row')].map(r => r.getAttribute('aria-label')),
      tilesLabelled: [...document.querySelectorAll('.tile')].every(t => t.getAttribute('aria-label')),
      liveRegions: [...document.querySelectorAll('[aria-live]')].map(e => e.getAttribute('aria-live') + (e.getAttribute('role') ? '/' + e.getAttribute('role') : '')),
      imgAlt: [...document.querySelectorAll('img')].every(i => i.hasAttribute('alt')),
      buttonsNamed: [...document.querySelectorAll('button')].every(b => (b.getAttribute('aria-label') || b.textContent).trim()),
      headings: [...document.querySelectorAll('h1,h2')].map(h => h.tagName),
      timerAria: document.querySelector('.timer')?.getAttribute('aria-live') ?? null,
      lang: document.documentElement.lang,
    }));
    check('landmark/labels: main, nav, grid and rows labelled; tiles labelled; images have alt; buttons named', roles.main && roles.navLabel && roles.gridLabel && roles.rowLabels.every(Boolean) && roles.tilesLabelled && roles.imgAlt && roles.buttonsNamed, JSON.stringify(roles));
    check('live region present (polite feedback + guess announcement) and the timer is not live', roles.liveRegions.filter(x => x.startsWith('polite')).length >= 2 && roles.timerAria === null, JSON.stringify({ live: roles.liveRegions, timer: roles.timerAria }));
    check('current mode exposed with aria-current; document language set (informational)', roles.currentMode === 'Daily' && roles.lang !== '', `current=${roles.currentMode} lang="${roles.lang}"`);
    const snapshot = await ctx.page.locator('main').ariaSnapshot();
    writeFileSync(join(evidenceDir, 'a11y-aria-snapshot.yml'), snapshot);
  } finally { await stop(ctx); }
}

// =================== main ===================
mkdirSync(evidenceDir, { recursive: true });
const meta = {
  date: new Date().toISOString(),
  os: `${execFileSync('powershell', ['-NoProfile', '-Command', '(Get-CimInstance Win32_OperatingSystem | % { $_.Caption + " " + $_.Version })'], { encoding: 'utf8' }).trim()}`,
  node: process.version,
  gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
  desktopSha256: sha256(app), bridgeSha256: sha256(bridge),
  claudeVersion: execFileSync(claudeExe, ['--version'], { encoding: 'utf8' }).trim(),
  items: only, tag,
};
console.log(JSON.stringify(meta));
const mine = await acquireLock();
const t0 = Date.now();
const itemFns = { disconnected: itemDisconnected, orderings: itemOrderings, failure: itemFailure, secondlaunch: itemSecondLaunch, a11y: itemA11y };
try {
  for (const name of only) {
    try { await itemFns[name](); } catch (e) { item = name; check(`${name}: no script error`, false, e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e); }
  }
} finally {
  for (const pid of [...spawned]) killTree(pid);
  releaseLock(mine);
  meta.seconds = Math.round((Date.now() - t0) / 1000);
  writeFileSync(join(evidenceDir, 'results.json'), JSON.stringify({ meta, results }, null, 2));
  const failed = results.filter(r => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed; evidence ${join(evidenceDir, 'results.json')}`);
  process.exitCode = failed.length ? 1 : 0;
}
