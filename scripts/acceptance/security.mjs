/* global performance, document, window, clearTimeout */
// Packaged-app security acceptance: receiver rejections, private-file ACLs and reparse points,
// export/diagnostics privacy, no outbound traffic, and save-failure honesty.
//
//   node scripts/acceptance/security.mjs [--tag NAME] [--only receiver,acl,reparse,privacy,traffic,savefail]
//
// Runs the release app hidden (`--hook-launch`, never visible) against fresh throwaway profiles in
// <main checkout>/.local/native-smoke-sec-<tag>-*, with CLAWDLE_TEST_MODE=1. Real Claude Code runs only
// against the synthetic loopback provider in scripts/claude-lifecycle-smoke.py. Never touches ~/.claude.
// Holds .local/locks/machine.lock only while the checks run. Writes <tag>-results.json next to the profiles.
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const worktreeMarker = `${sep}.claude${sep}worktrees${sep}`;
const here = resolve(scriptDir, '..', '..');
const repo = process.env.CLAWDLE_MAIN_CHECKOUT || (here.includes(worktreeMarker) ? here.slice(0, here.indexOf(worktreeMarker)) : here);
const release = join(repo, 'target', 'release');
const app = join(release, 'clawdle-desktop.exe');
const bridge = join(release, 'clawdle-bridge.exe');
const claudeExe = process.env.CLAUDE_EXE || join(os.homedir(), '.local', 'bin', 'claude.exe');
const winPs1 = join(scriptDir, 'security.win.ps1');
const dbPy = join(scriptDir, 'security.db.py');
const lockFile = join(repo, '.local', 'locks', 'machine.lock');
const CDP_PORT = 9342;

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const tag = opt('tag', new Date().toISOString().slice(5, 16).replace(/[-:T]/g, ''));
const only = new Set((opt('only', 'receiver,acl,reparse,privacy,traffic,savefail')).split(','));
const profile = name => join(repo, '.local', `native-smoke-sec-${tag}-${name}`);
const resultsFile = join(repo, '.local', `native-smoke-sec-${tag}-results.json`);

const require = createRequire(join(repo, 'package.json'));
const { chromium } = require('@playwright/test');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex');

const results = [];
function record(item, check, status, detail = '', evidence) {
  results.push({ item, check, status, detail, evidence });
  console.log(`${status.padEnd(4)} [${item}] ${check}${detail ? ' :: ' + detail : ''}`);
}
const pass = (item, check, ok, detail, evidence) => record(item, check, ok ? 'PASS' : 'FAIL', detail, evidence);
const info = (item, check, detail, evidence) => record(item, check, 'INFO', detail, evidence);

// ---------- process helpers ----------
function ps(...a) {
  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', winPs1, ...a], { encoding: 'utf8', timeout: 90000 });
  if (r.status !== 0) throw new Error(`security.win.ps1 ${a[0]} failed: ${(r.stderr || r.stdout).slice(0, 300)}`);
  return JSON.parse(r.stdout.trim());
}
function py(...a) {
  const r = spawnSync('python', ['-I', dbPy, ...a], { encoding: 'utf8', timeout: 180000 });
  if (r.status !== 0) throw new Error(`security.db.py ${a[0]} failed: ${(r.stderr || r.stdout).slice(-300)}`);
  return r.stdout.trim();
}
const snapshot = dataDir => JSON.parse(py('snapshot', join(dataDir, 'clawdle.sqlite')));
function testEnv(dataDir, extra = {}) {
  return { ...process.env, CLAWDLE_TEST_MODE: '1', CLAWDLE_DATA_DIR: dataDir, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}`, ...extra };
}
function runBridge(argv, dataDir, input = '') {
  const t0 = performance.now();
  const r = spawnSync(bridge, argv, { env: testEnv(dataDir), input, encoding: 'utf8', timeout: 20000, windowsHide: true });
  return { code: r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim(), ms: Math.round(performance.now() - t0) };
}
const killTree = pid => spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
const appRunning = () => spawnSync('tasklist', ['/FI', 'IMAGENAME eq clawdle-desktop.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8' }).stdout.toLowerCase().includes('clawdle-desktop.exe');
const cdpUp = async () => { try { return (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).ok; } catch { return false; } };

async function startApp(dataDir, { cdp = true, waitEndpoint = true } = {}) {
  if (appRunning()) throw new Error('a clawdle-desktop.exe is already running (single-instance would redirect); refusing');
  const proc = spawn(app, ['--hook-launch'], { env: testEnv(dataDir), stdio: 'ignore', windowsHide: true });
  const started = performance.now();
  if (waitEndpoint) for (let i = 0; i < 60 && !existsSync(join(dataDir, 'endpoint.json')); i++) await sleep(250);
  const handle = { proc, dataDir, browser: null, page: null, endpointMs: Math.round(performance.now() - started) };
  if (cdp) {
    for (let i = 0; i < 60 && !(await cdpUp()); i++) await sleep(250);
    handle.browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
    for (let i = 0; i < 60 && !handle.page; i++) { handle.page = handle.browser.contexts()[0]?.pages()[0]; if (!handle.page) await sleep(250); }
    await handle.page.waitForSelector('button[aria-label="Settings"]', { timeout: 20000 });
  }
  return handle;
}
async function stopApp(h) {
  if (!h) return;
  try { await h.browser?.close(); } catch { /* already gone */ }
  killTree(h.proc.pid);
  for (let i = 0; i < 40 && (appRunning() || (await cdpUp())); i++) await sleep(250);
}
const isVisible = h => h.page.evaluate(() => window.__TAURI_INTERNALS__.invoke('native_is_visible'));

// ---------- UI helpers (DOM-driven so they work on a hidden window) ----------
const keyClick = (page, letter) => page.evaluate(l => [...document.querySelectorAll('button.key')].find(b => b.textContent === l)?.click(), letter);
const labelClick = (page, label) => page.evaluate(l => document.querySelector(`button[aria-label="${l}"]`)?.click(), label);
const textClick = (page, re) => page.evaluate(src => { const rx = new RegExp(src, 'i'); const b = [...document.querySelectorAll('button, a')].find(x => rx.test(x.getAttribute('aria-label') || '') || rx.test(x.textContent || '')); b?.click(); return !!b; }, re);
async function typeWord(page, word) { for (const l of word) { await keyClick(page, l); await sleep(40); } }
async function clearDraft(page) { for (let i = 0; i < 6; i++) { await labelClick(page, 'Delete letter'); await sleep(40); } }
const feedback = page => page.evaluate(() => document.querySelector('.feedback')?.textContent?.trim() ?? '');
const board = page => page.evaluate(() => [...document.querySelectorAll('.grid-row')].map(r => [...r.querySelectorAll('.tile')].map(t => t.getAttribute('aria-label')).join('|')));
const scoredRows = rows => rows.filter(r => r.split('|').every(l => /,\s*(correct|present|absent)/i.test(l))).length;
const terminal = page => page.evaluate(() => !!document.querySelector('.result-panel'));
async function waitFor(fn, ms, step = 150) { const end = performance.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (performance.now() > end) return false; await sleep(step); } }

// ---------- filesystem helpers ----------
const fixtureGuard = p => { if (!resolve(p).startsWith(join(repo, '.local', 'native-smoke-sec-'))) throw new Error('refusing path outside native-smoke-sec fixtures: ' + p); return p; };
function junction(link, target) { fixtureGuard(link); fixtureGuard(target); const r = spawnSync('cmd.exe', ['/c', 'mklink', '/J', link, target], { encoding: 'utf8' }); if (r.status !== 0) throw new Error('mklink /J failed: ' + r.stdout + r.stderr); }
function unlink(link) { fixtureGuard(link); const st = lstatSync(link); if (!st.isSymbolicLink()) throw new Error('not a link: ' + link);
  try { rmdirSync(link); } catch { unlinkSync(link); } }
const listDir = d => { try { return readdirSync(d); } catch { return null; } };
function walk(dir, out = []) {
  for (const name of listDir(dir) ?? []) {
    const p = join(dir, name);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}
function scan(dir, needles, { skip = () => false } = {}) {
  const hits = []; let files = 0; let unreadable = 0; let bytes = 0;
  for (const file of walk(dir)) {
    let buf; try { buf = readFileSync(file); } catch { unreadable++; continue; }
    files++; bytes += buf.length;
    for (const n of needles) if (!skip(file, n.name) && buf.includes(n.value)) hits.push({ file: file.slice(dir.length + 1), needle: n.name });
  }
  return { files, bytes, unreadable, hits };
}
const textHits = (label, text, needles) => needles.filter(n => text.includes(n.value)).map(n => `${label}:${n.name}`);

// ---------- ACL ----------
let me = '';
const ALLOWED_PRINCIPALS = () => new Set([me.toLowerCase(), 'nt authority\\system', 'owner rights']);
function aclCheck(path) {
  const a = ps('acl', '-Path', path);
  const bad = a.rules.filter(r => !ALLOWED_PRINCIPALS().has(r.identity.toLowerCase()) || r.type !== 'Allow');
  const ok = bad.length === 0 && (a.protected === true || a.rules.every(r => r.inherited)) && a.rules.length > 0 && a.owner.toLowerCase() === me.toLowerCase();
  return { ok, owner: a.owner, protected: a.protected, inheritedOnly: a.rules.every(r => r.inherited), principals: [...new Set(a.rules.map(r => `${r.identity}:${r.rights}`))], bad: bad.map(r => r.identity), icacls: a.icacls };
}
function aclRecord(name, path) {
  const v = aclCheck(path);
  pass('private-files', `ACL ${name}`, v.ok, `owner=${v.owner.split('\\').pop()} protected=${v.protected}${v.protected ? '' : ' (inherits from the protected parent)'} principals=${v.principals.join(',')}${v.bad.length ? ' BROAD=' + v.bad.join(',') : ''}`, { icacls: v.icacls });
  return v.ok;
}

// ---------- raw HTTP ----------
function exchange(port, write, { timeout = 6000, host = '127.0.0.1' } = {}) {
  return new Promise(resolveExchange => {
    const t0 = performance.now(); let buf = Buffer.alloc(0); let first = null; let finished = false; let code = null; let closed = false;
    const sock = net.connect({ host, port });
    const finish = why => {
      if (finished) return; finished = true; clearTimeout(timer); sock.destroy();
      const m = /^HTTP\/1\.1 (\d{3})/.exec(buf.toString('latin1'));
      resolveExchange({ status: m ? Number(m[1]) : null, firstByteMs: first === null ? null : Math.round(first - t0), totalMs: Math.round(performance.now() - t0), why, code, closed, body: buf.toString('latin1').split('\r\n\r\n')[1] ?? '' });
    };
    const timer = setTimeout(() => finish('timeout'), timeout);
    sock.on('data', d => { first ??= performance.now(); buf = Buffer.concat([buf, d]); if (/\r\n\r\n/.test(buf.toString('latin1'))) setTimeout(() => finish('response'), 40); });
    sock.on('error', e => { code = e.code; finish('error'); });
    sock.on('close', () => { closed = true; finish('closed'); });
    sock.on('connect', () => { Promise.resolve(write(sock)).catch(() => {}); });
  });
}
function request({ method = 'POST', path = '/v1/events', host, token, origin, ct = 'application/json', body = '', query = '', len, extra = [] }) {
  const h = [`${method} ${path}${query} HTTP/1.1`, `Host: ${host}`];
  if (token !== undefined) h.push(`Authorization: Bearer ${token}`);
  if (origin) h.push(`Origin: ${origin}`);
  if (ct) h.push(`Content-Type: ${ct}`);
  h.push(`Content-Length: ${len ?? Buffer.byteLength(body)}`, 'Connection: close', ...extra);
  return h.join('\r\n') + '\r\n\r\n' + body;
}
const probeConnect = (host, port, timeout = 2500) => new Promise(r => {
  const s = net.connect({ host, port }); const t0 = performance.now();
  const done = v => { s.destroy(); r({ result: v, ms: Math.round(performance.now() - t0) }); };
  s.setTimeout(timeout, () => done('timeout')); s.on('connect', () => done('connected')); s.on('error', e => done(e.code || 'error'));
});

// =====================================================================================
async function itemReceiver(h) {
  const dir = h.dataDir;
  const token = readFileSync(join(dir, 'token'), 'utf8');
  const endpoint = JSON.parse(readFileSync(join(dir, 'endpoint.json'), 'utf8'));
  const port = endpoint.port; const host = `127.0.0.1:${port}`;
  const before = snapshot(dir).journalByKind;
  const pidAlive = endpoint.pid === h.proc.pid;
  pass('receiver', 'endpoint.json published by the app process', pidAlive, `port=${port} pid matches spawned app=${pidAlive} publishedAfterMs=${h.endpointMs}`);

  const jsonBody = '{"x":1}';
  const cases = [
    { name: 'control: health with correct token+Host', expect: [200], req: () => request({ method: 'GET', path: '/v1/health', host, token, ct: null }) },
    { name: 'control: correct auth, body {} reaches validation', expect: [400], req: () => request({ host, token, body: '{}' }) },
    { name: 'no Authorization header', expect: [401], req: () => request({ host, body: jsonBody }) },
    { name: 'wrong token (same length)', expect: [401], req: () => request({ host, token: token.replace(/./g, 'a'), body: jsonBody }) },
    { name: 'truncated token', expect: [401], req: () => request({ host, token: token.slice(0, 32), body: jsonBody }) },
    { name: 'wrong Origin (browser-style)', expect: [401], req: () => request({ host, token, origin: 'http://evil.example', body: jsonBody }) },
    { name: 'Origin: null', expect: [401], req: () => request({ host, token, origin: 'null', body: jsonBody }) },
    { name: 'wrong Host (other port)', expect: [401], req: () => request({ host: '127.0.0.1:1', token, body: jsonBody }) },
    { name: 'wrong Host (localhost name)', expect: [401], req: () => request({ host: `localhost:${port}`, token, body: jsonBody }) },
    { name: 'wrong Host (DNS-rebinding style)', expect: [401], req: () => request({ host: `evil.example:${port}`, token, body: jsonBody }) },
    { name: 'credential in query string', expect: [401], req: () => request({ host, token, query: `?token=${token}`, body: jsonBody }) },
    { name: 'unauthenticated health', expect: [401], req: () => request({ method: 'GET', path: '/v1/health', host, ct: null }) },
    { name: 'wrong Content-Type', expect: [415], req: () => request({ host, token, ct: 'text/plain', body: jsonBody }) },
    { name: 'malformed JSON', expect: [400], req: () => request({ host, token, body: '{not json' }) },
    { name: 'oversized body (9000 B > 8 KiB cap)', expect: [413], req: () => request({ host, token, body: JSON.stringify({ pad: 'a'.repeat(9000) }) }) },
    { name: 'oversized body (1 MiB)', expect: [413], req: () => request({ host, token, body: 'a'.repeat(1024 * 1024) }), allowReset: true },
  ];
  for (const c of cases) {
    const r = await exchange(port, s => s.write(c.req()));
    const ok = c.expect.includes(r.status) || (c.allowReset && r.status === null && r.code === 'ECONNRESET');
    pass('receiver', c.name, ok, `status=${r.status ?? r.code} firstByte=${r.firstByteMs}ms total=${r.totalMs}ms`, c.name.startsWith('control: health') ? { bodyHasToken: r.body.includes(token) } : undefined);
  }
  const health = await exchange(port, s => s.write(request({ method: 'GET', path: '/v1/health', host, token, ct: null })));
  pass('receiver', 'health body carries no token', !health.body.includes(token), health.body.slice(0, 120).replace(/[0-9a-f-]{36}/, '<epoch>'));

  // Slow body: promise 2000 bytes, send 10, then stall. The receiver bounds body reads at 100 ms.
  const slow = await exchange(port, async s => { s.write(request({ host, token, body: '', len: 2000 })); await sleep(30); s.write('x'.repeat(10)); }, { timeout: 8000 });
  pass('receiver', 'slow body (10 of 2000 bytes, then stall) rejected', slow.status === 413 && slow.firstByteMs < 2000, `status=${slow.status} rejectedAfter=${slow.firstByteMs}ms (server read bound 100 ms)`);
  // Slow-loris on headers: never finish the header block, one byte every 500 ms.
  const loris = await exchange(port, async s => { s.write(`POST /v1/events HTTP/1.1\r\nHost: ${host}\r\n`); for (let i = 0; i < 24; i++) { await sleep(500); s.write('X-A: b\r\n'); } }, { timeout: 14000 });
  pass('receiver', 'slow-loris on headers is cut off within 3 s (receiver header timeout 500 ms)', loris.why !== 'timeout' && loris.totalMs < 3000, `outcome=${loris.why}${loris.code ? ':' + loris.code : ''} status=${loris.status} after ${loris.totalMs}ms of a 12 s one-line-per-500 ms trickle`);
  // Rate limit.
  const burst = await Promise.all(Array.from({ length: 150 }, () => exchange(port, s => s.write(request({ host, token, body: '{}' })), { timeout: 8000 })));
  const tally = {}; for (const r of burst) tally[r.status ?? r.code] = (tally[r.status ?? r.code] ?? 0) + 1;
  pass('receiver', 'rate limit (150 concurrent authenticated posts)', (tally[429] ?? 0) > 0, `status tally ${JSON.stringify(tally)}`);

  const after = snapshot(dir).journalByKind;
  pass('receiver', 'no rejected request reached the journal', JSON.stringify(before.agent ?? 0) === JSON.stringify(after.agent ?? 0), `agent rows before=${before.agent ?? 0} after=${after.agent ?? 0}`);

  // Interfaces. Everything the app process tree owns that is listening.
  const sockets = ps('sockets', '-RootPid', String(h.proc.pid));
  const listeners = sockets.sockets.filter(s => s.proto === 'tcp' && s.state === 'Listen');
  const onPort = listeners.filter(s => s.localPort === port);
  pass('receiver', 'receiver listens on exactly 127.0.0.1', onPort.length === 1 && onPort[0].localAddress === '127.0.0.1', `listeners on :${port} = ${onPort.map(s => s.localAddress).join(',') || 'none'}`);
  pass('receiver', 'no wildcard or ::1 listener on the receiver port', !listeners.some(s => s.localPort === port && s.localAddress !== '127.0.0.1'), 'checked 0.0.0.0, ::, ::1');
  info('receiver', 'all TCP listeners owned by the app tree', listeners.map(s => `${s.localAddress}:${s.localPort} (${s.role}${s.localPort === CDP_PORT ? ', test-harness CDP port' : ''})`).join('; '));
  const lan = Object.values(os.networkInterfaces()).flat().filter(a => a && !a.internal && !a.address.startsWith('fe80') && !a.address.startsWith('169.254'));
  const targets = [['127.0.0.1', 'control: loopback should connect'], ['::1', 'IPv6 loopback'], ['127.0.0.2', 'other 127/8 address'], ...lan.map(a => [a.address, `LAN ${a.family} address`])];
  for (const [addr, label] of targets) {
    const r = await probeConnect(addr, port);
    const wantConnected = addr === '127.0.0.1';
    pass('receiver', `connect ${label}`, wantConnected ? r.result === 'connected' : r.result !== 'connected', `${r.result} in ${r.ms}ms`);
  }
  return port;
}

async function itemPrivateFiles(dataDir) {
  // Live files published by the running app.
  for (const f of ['token', 'endpoint.json']) aclRecord(f, join(dataDir, f));
  aclRecord('data directory', dataDir);
  // Control: the checker must flag a broad grant on a fixture file.
  const control = join(profile('acl-control'), 'broad.txt');
  mkdirSync(profile('acl-control')); writeFileSync(control, 'x');
  spawnSync('icacls.exe', [control, '/grant', '*S-1-1-0:(R)'], { stdio: 'ignore' });
  const flagged = !aclCheck(control).ok;
  pass('private-files', 'control: checker flags a file granted to Everyone', flagged, 'fixture file with an Everyone read grant is rejected by the same check');
  spawnSync('icacls.exe', [control, '/remove', '*S-1-1-0'], { stdio: 'ignore' });

  // Mailbox + ownership manifest + settings backup via the real bridge (no app involved).
  const M = profile('mailbox'); const data = join(M, 'data'); const project = join(M, 'project');
  mkdirSync(M); mkdirSync(join(project, '.claude'), { recursive: true });
  const settings = join(project, '.claude', 'settings.local.json');
  writeFileSync(settings, JSON.stringify({ env: { SECURITY_FIXTURE: 'preserved' } }));
  const install = runBridge(['install', 'claude', '--scope', 'project', '--project', project], data);
  pass('private-files', 'bridge install into fixture project', install.code === 0, `exit=${install.code} ${install.ms}ms`);
  const cfgPath = join(data, 'bridge.json');
  const cfg = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, 'utf8')) : {};
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, autoLaunch: true, desktopPath: join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'whoami.exe') }));
  const hookInput = JSON.stringify({ session_id: randomUUID(), prompt_id: randomUUID(), hook_event_name: 'UserPromptSubmit' });
  const hook = runBridge(['hook', '--provider', 'claude'], data, hookInput);
  const mailbox = join(data, 'mailbox'); const entries = listDir(mailbox) ?? [];
  pass('private-files', 'cold-start hook wrote a mailbox entry (receiver down)', hook.code === 0 && entries.length === 1, `exit=${hook.code} in ${hook.ms}ms, entries=${entries.length}`);
  aclRecord('bridge install: data directory', data);
  aclRecord('token (created by hook)', join(data, 'token'));
  if (entries.length) { aclRecord('mailbox directory', mailbox); aclRecord('mailbox entry', join(mailbox, entries[0])); }
  const own = join(data, 'ownership');
  aclRecord('ownership directory', own);
  for (const f of listDir(own) ?? []) aclRecord(`ownership/${f.length > 24 ? f.slice(0, 12) + '…' : f}`, join(own, f));
  const backups = (listDir(join(project, '.claude')) ?? []).filter(n => n.includes('clawdle-backup'));
  pass('private-files', 'install produced a settings backup', backups.length >= 1, `${backups.length} backup file(s)`);
  for (const b of backups) aclRecord('settings backup', join(project, '.claude', b));
  const uninstall = runBridge(['uninstall', 'claude', '--scope', 'project', '--project', project], data);
  info('private-files', 'uninstall of fixture hooks', `exit=${uninstall.code}`);
}

async function itemReparse() {
  const base = profile('reparse'); mkdirSync(base);
  const T = name => { const d = join(base, `target-${name}`); mkdirSync(d); return d; };
  const neutral = d => { const l = listDir(d); return l && l.length === 0; };
  const aclOf = d => ps('acl', '-Path', d).rules.map(r => `${r.identity}:${r.rights}:${r.inherited}`).join(';');
  const mkProject = name => { const p = join(base, `project-${name}`); mkdirSync(join(p, '.claude'), { recursive: true }); writeFileSync(join(p, '.claude', 'settings.local.json'), '{"env":{"K":"v"}}'); return p; };
  const hookInput = () => JSON.stringify({ session_id: randomUUID(), prompt_id: randomUUID(), hook_event_name: 'UserPromptSubmit' });
  const cleanup = [];
  try {
    // 1. ownership dir is a junction -> install must refuse and leave the target untouched.
    {
      const data = join(base, 'data-ownership'); mkdirSync(data); const target = T('ownership'); const project = mkProject('own');
      const aclBefore = aclOf(target); const settingsBefore = sha256(join(project, '.claude', 'settings.local.json'));
      junction(join(data, 'ownership'), target); cleanup.push(join(data, 'ownership'));
      const r = runBridge(['install', 'claude', '--scope', 'project', '--project', project], data);
      pass('reparse', 'junction as ownership dir: install refused', r.code !== 0 && neutral(target) && sha256(join(project, '.claude', 'settings.local.json')) === settingsBefore, `exit=${r.code} err="${r.stderr.slice(0, 60)}" target entries=${listDir(target)?.length} settings unchanged=${sha256(join(project, '.claude', 'settings.local.json')) === settingsBefore} target ACL unchanged=${aclOf(target) === aclBefore}`);
    }
    // 2. token is a junction -> hook must not follow it.
    {
      const data = join(base, 'data-token'); mkdirSync(data); const target = T('token');
      junction(join(data, 'token'), target); cleanup.push(join(data, 'token'));
      const r = runBridge(['hook', '--provider', 'claude'], data, hookInput());
      pass('reparse', 'junction as token: hook refuses, nothing written through it', r.code === 0 && neutral(target) && !existsSync(join(data, 'endpoint.json')), `exit=${r.code} in ${r.ms}ms target entries=${listDir(target)?.length}`);
    }
    // 3. mailbox is a junction -> cold start must not write through it.
    {
      const data = join(base, 'data-mailbox'); mkdirSync(data); const target = T('mailbox'); const project = mkProject('mbx');
      runBridge(['install', 'claude', '--scope', 'project', '--project', project], data);
      const cfg = JSON.parse(readFileSync(join(data, 'bridge.json'), 'utf8'));
      writeFileSync(join(data, 'bridge.json'), JSON.stringify({ ...cfg, autoLaunch: true, desktopPath: join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'whoami.exe') }));
      junction(join(data, 'mailbox'), target); cleanup.push(join(data, 'mailbox'));
      const r = runBridge(['hook', '--provider', 'claude'], data, hookInput());
      pass('reparse', 'junction as mailbox: cold-start write refused', r.code === 0 && neutral(target), `exit=${r.code} in ${r.ms}ms target entries=${listDir(target)?.length}`);
    }
    // 4. project .claude is a junction -> settings merge must refuse.
    {
      const data = join(base, 'data-settings'); mkdirSync(data); const target = T('settings');
      const project = join(base, 'project-link'); mkdirSync(project); junction(join(project, '.claude'), target); cleanup.push(join(project, '.claude'));
      const r = runBridge(['install', 'claude', '--scope', 'project', '--project', project], data);
      pass('reparse', 'junction as project .claude: settings merge refused', r.code !== 0 && neutral(target), `exit=${r.code} err="${r.stderr.slice(0, 60)}" target entries=${listDir(target)?.length}`);
    }
    // 5. symlink token (needs Developer Mode or elevation).
    {
      const data = join(base, 'data-symlink'); mkdirSync(data); const target = T('symlink'); writeFileSync(join(target, 'real-token'), 'a'.repeat(64));
      let made = false;
      try { symlinkSync(join(target, 'real-token'), join(data, 'token'), 'file'); made = true; cleanup.push(join(data, 'token')); } catch (e) { info('reparse', 'file symlink as token', `not run: cannot create symlinks (${e.code})`); }
      if (made) {
        const r = runBridge(['hook', '--provider', 'claude'], data, hookInput());
        pass('reparse', 'file symlink as token: refused', r.code === 0 && readFileSync(join(target, 'real-token'), 'utf8') === 'a'.repeat(64) && !existsSync(join(data, 'endpoint.json')), `exit=${r.code}`);
      }
    }
    // 6. The app itself: a junction entry inside the data dir, and a data dir that is itself a junction.
    {
      const data = profile('reparse-app-entry'); mkdirSync(data); const target = T('app-entry');
      junction(join(data, 'mailbox'), target); cleanup.push(join(data, 'mailbox'));
      const h = await startApp(data, { cdp: false, waitEndpoint: false });
      await sleep(8000);
      const published = existsSync(join(data, 'endpoint.json'));
      const sockets = ps('sockets', '-RootPid', String(h.proc.pid)).sockets.filter(s => s.state === 'Listen');
      pass('reparse', 'app with junction entry in data dir: no receiver published, target untouched', !published && neutral(target) && sockets.length === 0, `endpoint.json published=${published} listeners=${sockets.length} processAlive=${h.proc.exitCode === null} target entries=${listDir(target)?.length}`);
      await stopApp(h);
    }
    {
      const real = T('app-datadir'); const data = profile('reparse-app-link');
      junction(data, real); cleanup.push(data);
      const h = await startApp(data, { cdp: false, waitEndpoint: false });
      await sleep(8000);
      pass('reparse', 'app with data dir itself a junction: nothing written through it', neutral(real) , `exited=${h.proc.exitCode !== null} target entries=${listDir(real)?.length} endpoint published=${existsSync(join(real, 'endpoint.json'))}`);
      await stopApp(h);
    }
  } finally {
    for (const link of cleanup.reverse()) { try { if (lstatSync(link).isSymbolicLink()) unlink(link); } catch { /* already removed */ } }
    const left = cleanup.filter(l => { try { return lstatSync(l).isSymbolicLink(); } catch { return false; } });
    info('reparse', 'planted links removed', left.length === 0 ? `all ${cleanup.length} links removed (link only, targets left in place)` : `STILL PRESENT: ${left.length}`);
  }
}

async function itemPrivacy(h) {
  const dir = h.dataDir; const page = h.page;
  const token = readFileSync(join(dir, 'token'), 'utf8');
  // A daily guess so the export has play in it.
  await typeWord(page, 'CRANE'); await labelClick(page, 'Submit guess'); await sleep(600);
  const fixture = profile('lifecycle');
  const run = spawnSync('python', ['-I', dbPy, 'lifecycle', '--', '--claude', claudeExe, '--bridge', bridge, '--data-dir', dir, '--fixture', fixture, '--scenario', 'success'], { encoding: 'utf8', timeout: 150000, env: { ...process.env, CLAWDLE_SMOKE_SCRIPT: join(repo, 'scripts', 'claude-lifecycle-smoke.py') } });
  let smoke = null; try { smoke = JSON.parse(readFileSync(join(fixture, 'result.json'), 'utf8')); } catch { /* reported below */ }
  pass('privacy', 'real Claude 2.1.282 turn via synthetic provider', run.status === 0 && smoke?.passed === true, `exit=${run.status} ${run.status ? (run.stderr || '').slice(-200) : ''} claude=${smoke?.claudeVersion} events=${(smoke?.events ?? []).map(e => e.sourceEvent).join(',')} providerPaths=${(smoke?.providerPaths ?? []).join(',')}`);
  if (!existsSync(join(fixture, 'identifiers.json'))) return;
  const ids = JSON.parse(readFileSync(join(fixture, 'identifiers.json'), 'utf8'));
  const transcriptHit = scan(fixture, [{ name: 'canary', value: Buffer.from(ids.canary) }]).hits.length;
  info('privacy', 'canary derivation sanity check', `canary found in the Claude fixture dir (its own transcript/config) in ${transcriptHit} file(s) - proves the needle is the real prompt`);
  await sleep(1500);

  const needles = [
    { name: 'token', value: Buffer.from(token) },
    { name: 'canary', value: Buffer.from(ids.canary) },
    { name: 'canary-prefix', value: Buffer.from('SYNTHETIC_PRIVATE_PROMPT_') },
    { name: 'sessionId', value: Buffer.from(ids.sessionId) },
    { name: 'user-home-path', value: Buffer.from(os.homedir()) },
  ];
  const textNeedles = needles.map(n => ({ name: n.name, value: n.value.toString() }));

  // Export: the Export button hands controller.exportData() to the native Save dialog, which cannot be driven
  // on a hidden window. Call the same controller method through the live React tree instead.
  const exportText = await page.evaluate(() => {
    const el = document.querySelector('main'); const key = Object.keys(el).find(k => k.startsWith('__reactFiber$'));
    for (let f = el[key]; f; f = f.return) { const c = f.memoizedProps?.controller; if (c && typeof c.exportData === 'function') return c.exportData(); }
    return null;
  });
  pass('privacy', 'export produced by controller.exportData() on the live page (native Save dialog not driven)', typeof exportText === 'string' && exportText.length > 0, `${exportText?.length} bytes`);
  const parsed = JSON.parse(exportText);
  pass('privacy', 'export satisfies the native_export validator shape', parsed.format === 'clawdle-export' && parsed.version === 1 && Array.isArray(parsed.games) && Array.isArray(parsed.results), `keys=${Object.keys(parsed).join(',')} games=${parsed.games.length} races=${parsed.races.length}`);
  const exportHits = textHits('export', exportText, textNeedles);
  pass('privacy', 'export contains no token, canary, session id or home path', exportHits.length === 0, exportHits.join(',') || 'none of 5 needles present');
  const forbiddenKeys = ['sessionId', 'turnId', 'token', 'prompt', 'transcript', 'response', 'command', 'endpoint'].filter(k => exportText.includes(`"${k}"`));
  pass('privacy', 'export has no session/turn/token/prompt/transcript keys', forbiddenKeys.length === 0, forbiddenKeys.join(',') || 'none');

  // Doctor through the real UI: Settings -> Claude connection settings -> Check connection.
  await labelClick(page, 'Settings'); await sleep(300);
  await textClick(page, 'Claude connection settings'); await sleep(300);
  await textClick(page, '^Check connection$');
  const doctor = await waitFor(() => page.evaluate(() => document.querySelector('[aria-label="Connection result"]')?.textContent || ''), 6000);
  pass('privacy', 'doctor report read from the UI Connection result', typeof doctor === 'string' && doctor.includes('tokenPresent'), `${doctor.length} bytes; tokenPresent=${/"tokenPresent":\s*true/.test(doctor)}`);
  const doctorHits = textHits('ui-doctor', doctor, textNeedles);
  pass('privacy', 'UI doctor report contains no token, canary, session id or home path', doctorHits.length === 0, doctorHits.join(',') || 'none');
  const bridgeDoctor = runBridge(['doctor'], dir);
  const bdHits = textHits('bridge-doctor', bridgeDoctor.stdout, textNeedles);
  pass('privacy', 'bridge doctor CLI report contains no token, canary, session id or home path', bridgeDoctor.code === 0 && bdHits.length === 0, `exit=${bridgeDoctor.code} ${bdHits.join(',') || 'none'} tokenPresent=${/"tokenPresent":true/.test(bridgeDoctor.stdout)}`);
  await page.keyboard.press('Escape');

  writeFileSync(join(profile('lifecycle'), 'export.json'), exportText);
  writeFileSync(join(profile('lifecycle'), 'doctor-ui.txt'), doctor);
  writeFileSync(join(profile('lifecycle'), 'doctor-bridge.txt'), bridgeDoctor.stdout);
  const stillHidden = !(await isVisible(h));
  await stopApp(h);

  // On-disk scan after the app has exited so no file is locked.
  const skipToken = (file, needle) => needle === 'token' && file.endsWith(`${sep}token`);
  const disk = scan(dir, needles, { skip: skipToken });
  const grouped = {}; for (const hit of disk.hits) (grouped[hit.needle] ??= new Set()).add(hit.file.split(sep)[0]);
  const bad = disk.hits.filter(x => ['token', 'canary', 'canary-prefix'].includes(x.needle));
  pass('privacy', 'app data dir (sqlite, WAL, bridge.json, endpoint, webview profile) holds no canary or prompt prefix', !bad.some(x => x.needle !== 'token'), `${disk.files} files / ${disk.bytes} bytes scanned (${disk.unreadable} unreadable); hits: ${disk.hits.length ? JSON.stringify(Object.fromEntries(Object.entries(grouped).map(([k, v]) => [k, [...v].join('/')]))) : 'none'}`);
  pass('privacy', 'token appears in no file other than token', !bad.some(x => x.needle === 'token'), bad.filter(x => x.needle === 'token').map(x => x.file).join(',') || 'none');
  info('privacy', 'session id in the local journal (by design: sanitized local correlation id)', disk.hits.filter(x => x.needle === 'sessionId').map(x => x.file).join(', ') || 'not present');
  pass('privacy', 'app stayed hidden through the run', stillHidden, 'native_is_visible=false at the end of the run');
}

async function itemTraffic() {
  const dir = profile('traffic'); mkdirSync(dir);
  const h = await startApp(dir);
  const seconds = 60;
  const out = join(dir, '..', `native-smoke-sec-${tag}-traffic-sample.json`);
  const requests = new Set(); const sockets = [];
  h.browser.contexts()[0].on('request', r => requests.add(r.url().replace(/[?#].*$/, '').replace(/(https?:\/\/[^/]+\/[^/]*).*/, '$1')));
  h.page.on('websocket', w => sockets.push(w.url()));
  const sampler = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', winPs1, 'sample', '-RootPid', String(h.proc.pid), '-Seconds', String(seconds + 6), '-Out', out], { stdio: 'ignore' });
  const samplerDone = new Promise(r => sampler.on('exit', r));
  await sleep(3000);
  const words = ['CRANE', 'SLOTH', 'MIGHT', 'BUMPY', 'FJORD', 'WALTZ'];
  const t0 = performance.now(); let guesses = 0; let w = 0;
  const visibleSamples = [];
  while (performance.now() - t0 < seconds * 1000) {
    if (await terminal(h.page)) { await textClick(h.page, 'Next word|Keep playing in Endless'); await sleep(500); w = 0; continue; }
    await typeWord(h.page, words[w++ % words.length]); await labelClick(h.page, 'Submit guess'); guesses++;
    if (guesses % 3 === 0) { await labelClick(h.page, 'How to play'); await sleep(300); await h.page.keyboard.press('Escape'); await textClick(h.page, '^Endless$'); }
    visibleSamples.push(await isVisible(h));
    await sleep(5000);
  }
  await samplerDone;
  const state = snapshot(dir);
  const sample = JSON.parse(readFileSync(out, 'utf8').replace(/^\uFEFF/, ''));
  const loop = a => !a || a === '' || /^(127\.|::1$|0\.0\.0\.0$|::$)/.test(a);
  const tcp = sample.observed.filter(o => o.proto === 'tcp'); const udp = sample.observed.filter(o => o.proto === 'udp');
  const external = tcp.filter(o => !loop(o.remoteAddress));
  const appExternal = external.filter(o => o.role === 'app');
  const webviewExternal = external.filter(o => o.role !== 'app');
  const byRole = {}; for (const o of sample.observed) byRole[o.role] = (byRole[o.role] ?? 0) + 1;
  pass('traffic', 'gameplay really happened (daily + endless guesses journaled)', state.commandTypes.filter(t => /guess/i.test(t)).length >= 3, `${guesses} guess attempts, command types: ${[...new Set(state.commandTypes)].join(',')}, journal commands=${state.journalByKind.command}`);
  pass('traffic', `application process (clawdle-desktop.exe): no non-loopback TCP peer in ${seconds}s`, appExternal.length === 0, `${sample.samples} samples every ${sample.intervalMs}ms over ${Object.keys(sample.processes).length} processes; app flows=${tcp.filter(o => o.role === 'app').length}, all loopback`, { processes: sample.processes });
  const peers = [...new Set(webviewExternal.map(o => `${o.role} -> ${o.remote} (${o.state}, seen in ${o.count}/${sample.samples} samples, first sample ${o.first})`))];
  if (webviewExternal.length) info('traffic', 'WebView2 browser-internal non-loopback TCP (separate from application traffic; NOT gated)', peers.join('; '), { webviewExternal });
  else pass('traffic', 'WebView2 children: no non-loopback TCP peer', true, `roles seen: ${JSON.stringify(byRole)}`);
  const udpNon = udp.filter(o => !/^(127\.|::1$)/.test(o.local));
  info('traffic', 'UDP endpoints bound by the app tree', udp.length ? udp.map(o => `${o.role} ${o.local}`).join('; ') : 'none');
  if (udpNon.length) info('traffic', 'UDP endpoints on non-loopback addresses (bound sockets, not evidence of traffic)', udpNon.map(o => `${o.role} ${o.local}`).join('; '));
  const reqHosts = [...requests].map(u => { try { return new URL(u).host; } catch { return u; } });
  const foreign = [...new Set(reqHosts)].filter(x => !/^(tauri\.localhost|ipc\.localhost|localhost(:\d+)?|127\.0\.0\.1(:\d+)?)$/.test(x));
  pass('traffic', 'page-level requests only to the bundled tauri/ipc origins', foreign.length === 0 && sockets.length === 0, `${requests.size} distinct request URLs, hosts: ${[...new Set(reqHosts)].join(', ')}; websockets=${sockets.length}; foreign=${foreign.join(',') || 'none'}`);
  pass('traffic', 'window stayed hidden while playing', visibleSamples.every(v => v === false), `${visibleSamples.length} native_is_visible probes`);
  await stopApp(h);
}

async function itemSaveFailure() {
  const dir = profile('savefail'); mkdirSync(dir);
  const h = await startApp(dir); const page = h.page; const db = join(dir, 'clawdle.sqlite');
  try {
    await sleep(1500);
    const base = snapshot(dir);
    await typeWord(page, 'CRANE'); await labelClick(page, 'Submit guess');
    const ok1 = await waitFor(() => Object.values(snapshot(dir).games).some(g => g.guesses.length === 1), 6000);
    const s1 = snapshot(dir); const game = s1.games[s1.activeGameId];
    pass('save-failure', 'control: a guess with healthy storage is journaled and shown', ok1 && scoredRows(await board(page)) === 1, `journal commands ${base.journalByKind.command ?? 0} -> ${s1.journalByKind.command ?? 0}, rows shown=${scoredRows(await board(page))}`);
    const answer = game.wordId.split(':')[1].toUpperCase();

    // Fault: another connection holds the SQLite write lock for the whole fault window.
    const ready = join(dir, '..', `native-smoke-sec-${tag}-lock.ready`); const stop = join(dir, '..', `native-smoke-sec-${tag}-lock.stop`);
    const locker = spawn('python', ['-I', dbPy, 'lock', db, ready, stop, '120'], { stdio: 'ignore' });
    try {
      await waitFor(() => existsSync(ready), 8000);
      const baseline = snapshot(dir);
      const t0 = performance.now();
      await typeWord(page, 'SLOTH'); await labelClick(page, 'Submit guess');
      await sleep(9000);
      const s2 = snapshot(dir); const msg1 = await feedback(page); const rows1 = scoredRows(await board(page));
      pass('save-failure', 'locked storage: non-winning guess is not journaled', (s2.journalByKind.command ?? 0) === (baseline.journalByKind.command ?? 0) && s2.games[s2.activeGameId].guesses.length === 1, `journal commands ${baseline.journalByKind.command} -> ${s2.journalByKind.command}; saved guesses=${s2.games[s2.activeGameId].guesses.length}`);
      pass('save-failure', 'locked storage: UI does not show the guess as saved', rows1 === 1 && !/(was|has been|is) saved/i.test(msg1), `scored rows shown=${rows1}; feedback="${msg1}"`);
      pass('save-failure', 'locked storage: UI surfaces a storage error instead of silence', msg1.length > 0 && /lock|busy|unable|storage|save|database/i.test(msg1), `feedback="${msg1}" (${Math.round(performance.now() - t0)}ms after submit)`);

      await clearDraft(page);
      await typeWord(page, answer); await labelClick(page, 'Submit guess');
      await sleep(9000);
      const s3 = snapshot(dir); const rows2 = scoredRows(await board(page)); const msg2 = await feedback(page); const solvedShown = await terminal(page);
      pass('save-failure', 'locked storage: winning guess is not journaled and awards nothing', (s3.journalByKind.command ?? 0) === (baseline.journalByKind.command ?? 0) && s3.resultCount === baseline.resultCount && s3.games[s3.activeGameId].status === 'playing', `commands ${baseline.journalByKind.command} -> ${s3.journalByKind.command}; results ${baseline.resultCount} -> ${s3.resultCount}; game status=${s3.games[s3.activeGameId].status}`);
      pass('save-failure', 'locked storage: UI does not show a win or result panel', !solvedShown && rows2 === 1, `result panel shown=${solvedShown}; scored rows=${rows2}; feedback="${msg2}"`);
    } finally {
      writeFileSync(stop, 'stop');
      await new Promise(r => { locker.on('exit', r); setTimeout(r, 5000); });
    }

    // Recovery: after the lock is released the same player action must work and then be acknowledged.
    await sleep(500);
    await clearDraft(page); await typeWord(page, answer); await labelClick(page, 'Submit guess');
    const recovered = await waitFor(() => snapshot(dir).resultCount > 0, 10000);
    const s4 = snapshot(dir);
    pass('save-failure', 'after the lock is released the win saves and progression is recorded once', recovered && s4.resultCount === 1 && s4.games[s4.activeGameId].status === 'solved', `results=${s4.resultCount} status=${s4.games[s4.activeGameId]?.status} commands=${s4.journalByKind.command}`);
    pass('save-failure', 'app stayed hidden', !(await isVisible(h)), 'native_is_visible=false');
  } finally {
    writeFileSync(join(dir, '..', `native-smoke-sec-${tag}-lock.stop`), 'stop');
    await stopApp(h);
  }
}

// =====================================================================================
let lockOwned = false;
async function acquireLock() {
  mkdirSync(dirname(lockFile), { recursive: true });
  for (let i = 0; i < 80; i++) {
    try { writeFileSync(lockFile, `security-acceptance ${new Date().toISOString()}`, { flag: 'wx' }); lockOwned = true; return; } catch { if (i % 4 === 0) console.log('machine.lock held:', readFileSync(lockFile, 'utf8')); await sleep(15000); }
  }
  throw new Error('machine.lock still held after 20 minutes');
}

async function main() {
  for (const f of [app, bridge, claudeExe]) if (!existsSync(f)) throw new Error('missing ' + f);
  const osInfo = ps('os'); me = osInfo.user;
  const userSettings = join(os.homedir(), '.claude', 'settings.json');
  const userDigest = () => existsSync(userSettings) ? sha256(userSettings) : null;
  const userBefore = userDigest();
  const git = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8' }).stdout.trim();
  const claudeVersion = spawnSync(claudeExe, ['--version'], { encoding: 'utf8' }).stdout.trim();
  const meta = {
    date: new Date().toISOString(), os: `${osInfo.caption} ${osInfo.version}`, tag, mainHead: git(repo, 'rev-parse', 'HEAD'), claude: claudeVersion, node: process.version, python: spawnSync('python', ['--version'], { encoding: 'utf8' }).stdout.trim(),
    appSha256: sha256(app), bridgeSha256: sha256(bridge), appVersion: spawnSync('powershell', ['-NoProfile', '-Command', `(Get-Item '${app}').VersionInfo.ProductVersion`], { encoding: 'utf8' }).stdout.trim(),
  };
  console.log(JSON.stringify(meta, null, 1));
  await acquireLock();
  for (let i = 0; i < 40 && appRunning(); i++) { if (i === 0) console.log('clawdle-desktop.exe is running (another session); waiting under the lock'); await sleep(15000); }
  if (appRunning()) throw new Error('clawdle-desktop.exe still running after 10 minutes; refusing to start');
  let h;
  try {
    if (only.has('receiver') || only.has('privacy') || only.has('acl')) {
      const dir = profile('app'); mkdirSync(dir);
      h = await startApp(dir);
      pass('receiver', 'app launched hidden with --hook-launch', !(await isVisible(h)), 'native_is_visible=false');
      if (only.has('receiver')) await itemReceiver(h);
      if (only.has('acl')) await itemPrivateFiles(dir);
      if (only.has('privacy')) { await itemPrivacy(h); h = null; }
      else { await stopApp(h); h = null; }
    }
    if (only.has('reparse')) await itemReparse();
    if (only.has('traffic')) await itemTraffic();
    if (only.has('savefail')) await itemSaveFailure();
  } finally {
    try { await stopApp(h); } catch { /* best effort */ }
    if (lockOwned) rmSync(lockFile, { force: true });
  }
  pass('hygiene', 'user ~/.claude/settings.json unchanged', userDigest() === userBefore, userBefore ? 'sha256 identical before/after' : 'file absent before and after');
  pass('hygiene', 'no clawdle-desktop.exe left running', !appRunning(), '');
  const failed = results.filter(r => r.status === 'FAIL');
  writeFileSync(resultsFile, JSON.stringify({ meta, summary: { pass: results.filter(r => r.status === 'PASS').length, fail: failed.length, info: results.filter(r => r.status === 'INFO').length }, results }, null, 2));
  console.log(`\n${results.filter(r => r.status === 'PASS').length} pass, ${failed.length} fail, ${results.filter(r => r.status === 'INFO').length} info -> ${resultsFile}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch(e => { console.error('FATAL', e); if (lockOwned) rmSync(lockFile, { force: true }); process.exit(2); });
