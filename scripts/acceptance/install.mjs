/* global document */
// Packaged Windows install acceptance (docs/acceptance/install.md). One command:
//   node scripts/acceptance/install.mjs [--installer <setup.exe>] [--tag <id>] [--samples 40]
// Hidden/headless only: the app is launched solely with --hook-launch, all state lives in fresh
// .local/native-smoke-install-* profiles, and the machine lock in the main checkout is held only
// while runs execute. Never touches ~/.claude, the real Clawdle profile, or real projects.
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import net from 'node:net';
import {
  mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, statSync, rmSync, openSync, closeSync,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import os from 'node:os';
import { setTimeout, clearTimeout } from 'node:timers';
import { isDeepStrictEqual } from 'node:util';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');
const argv = process.argv.slice(2);
const opt = (name, fallback) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : fallback; };
const tag = opt('--tag', new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12));
const samples = Number(opt('--samples', '40'));
const gitCommon = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: repo, encoding: 'utf8' }).trim();
const mainCheckout = dirname(resolve(repo, gitCommon));
const installer = resolve(opt('--installer', join(mainCheckout, 'target', 'release', 'bundle', 'nsis', 'Clawdle_0.1.0_x64-setup.exe')));
const releaseDir = dirname(dirname(dirname(installer)));
const lockPath = join(mainCheckout, '.local', 'locks', 'machine.lock');
const evidenceDir = join(repo, '.local', `native-smoke-install-evidence-${tag}`);
const require = createRequire(join(repo, 'package.json'));
const probe = join(here, 'install-probe.ps1');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const results = []; // {item, check, pass, detail}
const installedDirs = [];
let currentItem = '';
const record = (check, pass, detail = '') => {
  results.push({ item: currentItem, check, pass: !!pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} [${currentItem}] ${check}${detail ? ' :: ' + detail : ''}`);
};
const observations = []; // facts worth recording that are not pass/fail
const observe = (what, detail = '') => { observations.push({ item: currentItem, what, detail }); console.log(`NOTE [${currentItem}] ${what}${detail ? ' :: ' + detail : ''}`); };
const measurements = {};
const p95 = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.ceil(s.length * 0.95) - 1]; };
const stats = (xs) => ({ n: xs.length, min: +Math.min(...xs).toFixed(1), median: +[...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)].toFixed(1), p95: +p95(xs).toFixed(1), max: +Math.max(...xs).toFixed(1) });
const ps = (...args) => JSON.parse(execFileSync('powershell', ['-NoProfile', '-File', probe, ...args], { encoding: 'utf8' }));
// A user-visible window is visible AND has real area. Tao/WebView2/IME helper windows are 15x15 and never shown.
const userVisible = (windows) => windows.filter((w) => { const [, , , size, vis] = w.split('|'); const [wd, ht] = size.split('x').map(Number); return vis === 'visible' && wd >= 100 && ht >= 100; });
const diffSummary = (a, b) => { const x = readFileSync(a), y = readFileSync(b); if (x.length !== y.length) return `sizes differ ${x.length} vs ${y.length}`; const d = []; for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) d.push(i); return `${d.length} differing bytes of ${x.length}${d.length ? ` (offsets ${d[0]}..${d.at(-1)})` : ''}`; };
// Only processes started from this harness's isolated install dirs count; other sessions' apps are not ours.
const mineOnly = (procs) => procs.filter((q) => q.path && q.path.toLowerCase().includes('native-smoke-install-'));
// Best effort: wait (<= 90 s) for total CPU busy < 35% so latency numbers are not dominated by other work; always records the load.
const settle = () => { let busy = ps('cpu').busyPct; for (let i = 0; i < 6 && busy >= 35; i++) { execFileSync('powershell', ['-NoProfile', '-Command', 'Start-Sleep -Seconds 10']); busy = ps('cpu').busyPct; } return busy; };
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

// Run a native exe with verbatim argument text (NSIS needs an unquoted, last /D=<path with spaces>).
function runVerbatim(exe, argText, timeoutMs) {
  return new Promise((res) => {
    const t0 = performance.now();
    const child = spawn(exe, [argText], { windowsVerbatimArguments: true, shell: false, stdio: 'ignore', windowsHide: true });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* best effort */ } res({ code: null, timedOut: true, ms: performance.now() - t0 }); }, timeoutMs);
    child.on('exit', (code) => { clearTimeout(timer); res({ code, timedOut: false, ms: performance.now() - t0 }); });
  });
}

// One bridge process with exact stdin bytes; returns wall time from spawn to close (includes Node spawn cost).
function runBridge(bridge, args, env, stdin, { closeStdin = true, timeoutMs = 3000 } = {}) {
  return new Promise((res) => {
    const t0 = performance.now();
    const child = spawn(bridge, args, { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = Buffer.alloc(0), err = Buffer.alloc(0);
    child.stdout.on('data', (d) => { out = Buffer.concat([out, d]); });
    child.stderr.on('data', (d) => { err = Buffer.concat([err, d]); });
    child.stdin.on('error', () => {});
    const timer = setTimeout(() => { try { child.kill(); } catch { /* best effort */ } }, timeoutMs);
    child.on('close', (code) => { clearTimeout(timer); res({ code, ms: performance.now() - t0, stdout: out.length, stderr: err.length, stdoutText: out.toString(), stderrText: err.toString() }); });
    if (stdin !== null) { if (closeStdin) child.stdin.end(stdin); else child.stdin.write(stdin); } else if (closeStdin) child.stdin.end();
  });
}

// Timing harness: PowerShell/.NET Stopwatch around Process.Start..WaitForExit (the method native-smoke.ps1 uses),
// so Node's own spawn cost is not charged to the bridge. Includes stdin write, process start and exit.
function bench(exe, args, env, stdin, { count = 1, warmup = 0, closeStdin = true, timeoutMs = 5000 } = {}) {
  const dir = join(evidenceDir, 'bench'); mkdirSync(dir, { recursive: true });
  const id = randomUUID();
  let stdinFile = null;
  if (stdin !== null && stdin.length) { stdinFile = join(dir, `${id}.stdin`); writeFileSync(stdinFile, stdin); }
  const specPath = join(dir, `${id}.json`);
  const envOverrides = {}; for (const k of ['CLAWDLE_TEST_MODE', 'CLAWDLE_DATA_DIR', 'WEBVIEW2_USER_DATA_FOLDER']) if (env[k]) envOverrides[k] = env[k];
  writeFileSync(specPath, JSON.stringify({ exe, args, env: envOverrides, stdinFile, closeStdin, timeoutMs, warmup, count }));
  const out = JSON.parse(execFileSync('powershell', ['-NoProfile', '-File', probe, 'bench', '-SpecPath', specPath], { encoding: 'utf8', maxBuffer: 1 << 26 }));
  return (Array.isArray(out.runs) ? out.runs : [out.runs]).map((r) => ({ ms: r.ms, life: r.life, code: r.exit, stdout: r.out, stderr: r.err, timedOut: r.timedOut }));
}
const python = (code, ...args) => execFileSync('python', ['-I', '-c', code, ...args], { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
function journal(profile) {
  const out = python(`
import json, pathlib, sqlite3, sys
con = sqlite3.connect(pathlib.Path(sys.argv[1]).resolve().as_uri() + '?mode=ro', uri=True, timeout=10)
rows = con.execute("SELECT seq,payload FROM event_journal WHERE kind='agent' ORDER BY seq").fetchall()
print(json.dumps([[s, json.loads(p).get('sessionId'), json.loads(p).get('sourceEvent')] for s, p in rows]))`, join(profile, 'clawdle.sqlite'));
  return JSON.parse(out);
}
function gameRows(profile) {
  const out = python(`
import json, pathlib, sqlite3, sys
con = sqlite3.connect(pathlib.Path(sys.argv[1]).resolve().as_uri() + '?mode=ro', uri=True, timeout=10)
rows = con.execute("SELECT g.mode, json_extract(g.payload,'$.status') FROM games g").fetchall()
daily = con.execute("SELECT count(*) FROM daily_games").fetchone()[0]
print(json.dumps({'games': rows, 'daily': daily}))`, join(profile, 'clawdle.sqlite'));
  return JSON.parse(out);
}

const hookPayload = (session, event = 'SessionStart') => JSON.stringify({ hook_event_name: event, session_id: session, prompt_id: randomUUID() });
const envFor = (profile, extra = {}) => ({ ...process.env, CLAWDLE_TEST_MODE: '1', CLAWDLE_DATA_DIR: profile, WEBVIEW2_USER_DATA_FOLDER: join(profile, 'webview'), ...extra });

async function acquireLock() {
  mkdirSync(dirname(lockPath), { recursive: true });
  for (let i = 0; i < 180; i++) {
    try { const fd = openSync(lockPath, 'wx'); writeFileSync(fd, `install-acceptance ${new Date().toISOString()}`); closeSync(fd); return; }
    catch (e) { if (e.code !== 'EEXIST') throw e; if (i === 0) console.log('machine.lock held: ' + readFileSync(lockPath, 'utf8')); await sleep(5000); }
  }
  throw new Error('machine.lock still held after 15 minutes; refusing to run.');
}
const countFiles = (d) => { try { return readdirSync(d, { recursive: true }).length; } catch { return -1; } };
const realAppDataDir = join(process.env.LOCALAPPDATA || '', 'org.clawdle.desktop');

// ---------------------------------------------------------------- hook-settings fixtures (items 2, 3)
const ORIGINAL = () => ({
  model: 'sonnet',
  env: { USER_VAR: 'ünï value' },
  permissions: { allow: ['Bash(git status)'], deny: ['Read(./secrets/**)'] },
  statusLine: { type: 'command', command: 'echo status' },
  hooks: {
    Stop: [{ hooks: [{ type: 'command', command: 'echo user-stop', timeout: 5 }] }],
    PostToolUse: [{ matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'node fmt.js', async: true }] }],
    SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'echo hello' }] }],
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo a' }, { type: 'command', command: 'echo b' }] }],
    PreCompact: [{ hooks: [{ type: 'command', command: 'echo compact' }] }],
  },
});
// Order-insensitive for object keys (the bridge re-serialises settings with sorted keys), order-sensitive for arrays.
const eq = (a, b) => isDeepStrictEqual(a, b);
// Drop empty event arrays: the bridge leaves `"Event": []` behind after removal (recorded as an observation).
const dropEmpty = (st) => { const c = JSON.parse(JSON.stringify(st)); if (c.hooks && !Array.isArray(c.hooks)) for (const k of Object.keys(c.hooks)) if (Array.isArray(c.hooks[k]) && !c.hooks[k].length) delete c.hooks[k]; if (c.hooks && !Object.keys(c.hooks).length) delete c.hooks; return c; };
const emptyEventKeys = (st) => Object.entries(st.hooks || {}).filter(([, v]) => Array.isArray(v) && !v.length).map(([k]) => k);
const isOurs = (h, bridge) => h && h.command === bridge && Array.isArray(h.args) && h.args[0] === 'hook';
const ours = (settings, bridge) => Object.entries(settings.hooks || {}).flatMap(([ev, groups]) => groups.flatMap((g) => (g.hooks || []).filter((h) => isOurs(h, bridge)).map((h) => ({ ev, h }))));
const stripOurs = (settings, bridge) => {
  const c = JSON.parse(JSON.stringify(settings));
  for (const [ev, groups] of Object.entries(c.hooks || {})) {
    for (const g of groups) g.hooks = (g.hooks || []).filter((h) => !isOurs(h, bridge));
    c.hooks[ev] = groups.filter((g) => g.hooks.length);
    if (!c.hooks[ev].length) delete c.hooks[ev];
  }
  return c;
};
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

async function hookSettingsSuite(label, bridge, profile, projectRoot) {
  const env = envFor(profile);
  const cli = (verb, project) => runBridge(bridge, [verb, 'claude', '--scope', 'project', '--project', project], env, null);
  const mk = (name, content) => {
    const proj = join(projectRoot, name); mkdirSync(join(proj, '.claude'), { recursive: true });
    const file = join(proj, '.claude', 'settings.local.json');
    if (content !== undefined) writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
    return { proj, file };
  };
  const expectedEvents = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Notification', 'Stop', 'StopFailure', 'SessionEnd', 'SubagentStop'];

  // S1: pre-existing unrelated hooks on the same events.
  const orig = ORIGINAL();
  const s1 = mk('proj-same-events', orig);
  const bytes0 = readFileSync(s1.file);
  let r = await cli('install', s1.proj);
  record(`${label}: install exit 0, status ok`, r.code === 0 && JSON.parse(r.stdoutText).status === 'ok', `exit=${r.code}`);
  let now = readJson(s1.file);
  record(`${label}: unrelated settings and hooks preserved after install`, eq(dropEmpty(stripOurs(now, bridge)), orig));
  const o1 = ours(now, bridge);
  record(`${label}: exactly one owned handler per event for all ${expectedEvents.length} events`, o1.length === expectedEvents.length && expectedEvents.every((ev) => o1.filter((x) => x.ev === ev).length === 1), o1.map((x) => x.ev).join(','));
  record(`${label}: Stop/StopFailure synchronous, others async, timeout 1`, o1.every(({ ev, h }) => h.timeout === 1 && (['Stop', 'StopFailure'].includes(ev) ? h.async === undefined : h.async === true)));
  record(`${label}: handler command is the installed bridge (absolute, exists)`, o1.every(({ h }) => h.command === bridge) && existsSync(bridge), bridge);
  record(`${label}: user same-event groups kept first, ours appended after`, ['Stop', 'PostToolUse', 'SessionStart', 'UserPromptSubmit'].every((ev) => eq(now.hooks[ev][0], orig.hooks[ev][0]) && now.hooks[ev].length === orig.hooks[ev].length + 1 && isOurs(now.hooks[ev].at(-1).hooks[0], bridge)));
  const keyOrderChanged = !eq(Object.keys(now), Object.keys(orig)) || !eq(Object.keys(now.hooks.Stop[0].hooks[0]), Object.keys(orig.hooks.Stop[0].hooks[0]));
  if (keyOrderChanged) observe(`${label}: install re-serialises the whole settings file with alphabetically sorted keys`, `original top-level order ${Object.keys(orig).join(',')} -> ${Object.keys(now).join(',')}`);
  const afterFirst = readFileSync(s1.file);
  r = await cli('install', s1.proj);
  const afterSecond = readFileSync(s1.file);
  now = readJson(s1.file);
  record(`${label}: repeat install is idempotent (no duplicates, unrelated intact)`, r.code === 0 && ours(now, bridge).length === expectedEvents.length && eq(dropEmpty(stripOurs(now, bridge)), orig), `byte-identical=${Buffer.compare(afterFirst, afterSecond) === 0}`);
  // User edits the file between install and uninstall; uninstall must not restore a stale backup over them.
  const edited = readJson(s1.file);
  edited.permissions.allow.push('Bash(ls)');
  edited.hooks.Stop.push({ hooks: [{ type: 'command', command: 'echo added-later' }] });
  edited.hooks.Notification = [...(edited.hooks.Notification || []), { hooks: [{ type: 'command', command: 'echo user-notify' }] }];
  writeFileSync(s1.file, JSON.stringify(edited, null, 2));
  const expectedAfterEdit = dropEmpty(stripOurs(edited, bridge));
  // Keep the install in place for later live-handler execution; uninstall is verified by the caller via `finish`.
  return {
    s1, orig, expectedAfterEdit, bytes0,
    async finish() {
      const u = await cli('uninstall', s1.proj);
      const fin = readJson(s1.file);
      record(`${label}: uninstall exit 0`, u.code === 0, `exit=${u.code}`);
      if (emptyEventKeys(fin).length) observe(`${label}: uninstall leaves empty event arrays in settings.hooks`, emptyEventKeys(fin).join(','));
      record(`${label}: uninstall removed only owned handlers and kept later user edits`, ours(fin, bridge).length === 0 && eq(dropEmpty(fin), expectedAfterEdit), `empty event arrays left behind: ${emptyEventKeys(fin).join(',') || 'none'}`);
      const u2 = await cli('uninstall', s1.proj);
      record(`${label}: repeat uninstall is a no-op`, u2.code === 0 && eq(dropEmpty(readJson(s1.file)), expectedAfterEdit));
      // Pristine round trip: install then uninstall with no edits restores the exact original JSON.
      const s2 = mk('proj-roundtrip', ORIGINAL());
      await cli('install', s2.proj); await cli('uninstall', s2.proj);
      const rt = readFileSync(s2.file);
      record(`${label}: install+uninstall round trip restores original settings`, eq(dropEmpty(JSON.parse(rt)), ORIGINAL()), `empty arrays left: ${emptyEventKeys(JSON.parse(rt)).join(',') || 'none'}; byte-identical=${rt.equals(Buffer.from(JSON.stringify(ORIGINAL(), null, 2)))}`);
      return fin;
    },
  };
}

async function extraSettingsScenarios(label, bridge, profile, projectRoot) {
  const env = envFor(profile);
  const cli = (verb, project) => runBridge(bridge, [verb, 'claude', '--scope', 'project', '--project', project], env, null);
  // No hooks key, no settings file, and invalid JSON.
  const noHooks = join(projectRoot, 'proj-no-hooks'); mkdirSync(join(noHooks, '.claude'), { recursive: true });
  const nhFile = join(noHooks, '.claude', 'settings.local.json');
  const nhOrig = { permissions: { allow: ['Bash(echo)'] }, env: { A: '1' } };
  writeFileSync(nhFile, JSON.stringify(nhOrig));
  await cli('install', noHooks); await cli('uninstall', noHooks);
  const nh = readJson(nhFile);
  const { hooks: nhHooks, ...nhRest } = nh;
  record(`${label}: file with no hooks key survives install+remove`, eq(nhRest, nhOrig) && !ours(nh, bridge).length, `leftover hooks object: ${JSON.stringify(nhHooks)}`);
  const none = join(projectRoot, 'proj-no-file'); mkdirSync(none, { recursive: true });
  const ri = await cli('install', none);
  const created = existsSync(join(none, '.claude', 'settings.local.json'));
  await cli('uninstall', none);
  const left = created ? readJson(join(none, '.claude', 'settings.local.json')) : null;
  record(`${label}: missing settings file installs, and remove leaves no owned handlers`, ri.code === 0 && created && ours(left, bridge).length === 0, `leftover=${JSON.stringify(left)}`);
  const bad = join(projectRoot, 'proj-invalid-json'); mkdirSync(join(bad, '.claude'), { recursive: true });
  const badFile = join(bad, '.claude', 'settings.local.json');
  const badText = '{ "hooks": { "Stop": [ // not json\n';
  writeFileSync(badFile, badText);
  const rb = await cli('install', bad);
  record(`${label}: invalid JSON is refused with the file untouched`, rb.code !== 0 && readFileSync(badFile, 'utf8') === badText, `exit=${rb.code} stderr=${rb.stderrText.trim()}`);
  const wrong = join(projectRoot, 'proj-hooks-wrong-shape'); mkdirSync(join(wrong, '.claude'), { recursive: true });
  const wrongFile = join(wrong, '.claude', 'settings.local.json');
  const wrongText = JSON.stringify({ hooks: ['not', 'an', 'object'], keep: true });
  writeFileSync(wrongFile, wrongText);
  const rw = await cli('install', wrong);
  record(`${label}: unsupported hooks shape is refused with the file untouched`, rw.code !== 0 && readFileSync(wrongFile, 'utf8') === wrongText, `exit=${rw.code} stderr=${rw.stderrText.trim()}`);
}

// ---------------------------------------------------------------- install layout cycle
async function cycle(layout, root, full) {
  const label = layout;
  const installDir = join(root, 'install dir');
  const profile = join(root, 'profile');
  const projectRoot = join(root, 'projects');
  mkdirSync(root, { recursive: true }); mkdirSync(profile); mkdirSync(projectRoot);
  const pre = ps('state');
  currentItem = 'install';
  record(`${label}: no pre-existing per-user Clawdle install state`, !pre.uninstallKey && !pre.manufacturerKey && !pre.startMenuLnk && !pre.desktopLnk && mineOnly(pre.clawdleProcesses).length === 0, JSON.stringify(pre.manufacturerKey));
  if (pre.uninstallKey || pre.startMenuLnk || pre.desktopLnk) throw new Error('Pre-existing Clawdle install/process; refusing to run the installer.');
  const preAppData = countFiles(realAppDataDir);

  // 1. install
  const inst = await runVerbatim(installer, `/S /D=${installDir}`, 120000);
  const after = ps('state');
  record(`${label}: silent install exit 0 (${Math.round(inst.ms)} ms)`, inst.code === 0 && !inst.timedOut, `exit=${inst.code}`);
  installedDirs.push(installDir);
  const app = join(installDir, 'clawdle-desktop.exe');
  const bridge = join(installDir, 'clawdle-bridge.exe');
  const listing = existsSync(installDir) ? readdirSync(installDir).filter((n) => !n.startsWith('notice-')) : [];
  record(`${label}: installed app, bridge, uninstaller, dictionary, licenses present`, existsSync(app) && existsSync(bridge) && existsSync(join(installDir, 'uninstall.exe')) && existsSync(join(installDir, 'words')) && existsSync(join(installDir, 'LICENSE')) && existsSync(join(installDir, 'licenses')), listing.join(', '));
  const appHash = sha256(app), bridgeHash = sha256(bridge);
  if (bridgeHash !== sha256(join(releaseDir, 'clawdle-bridge.exe'))) observe(`${label}: installed clawdle-bridge.exe differs from loose target/release/clawdle-bridge.exe (rebuilt since the installer was made?)`, `installed ${bridgeHash.slice(0, 16)}`);
  if (appHash !== sha256(join(releaseDir, 'clawdle-desktop.exe'))) observe(`${label}: installed clawdle-desktop.exe differs from target/release/clawdle-desktop.exe`, `installed ${appHash.slice(0, 16)}, target/release ${sha256(join(releaseDir, 'clawdle-desktop.exe')).slice(0, 16)}; ${diffSummary(app, join(releaseDir, 'clawdle-desktop.exe'))}`);
  measurements[`${label}.installedHashes`] = { app: appHash, bridge: bridgeHash, appBytes: statSync(app).size, bridgeBytes: statSync(bridge).size };
  measurements[`${label}.state.afterInstall`] = after;
  measurements[`${label}.installDirListing`] = listing;
  record(`${label}: install wrote HKCU uninstall key + HKCU\\Software\\clawdle key, Start menu and desktop shortcuts`, !!after.uninstallKey && !!after.manufacturerKey && !!after.startMenuLnk && !!after.desktopLnk, `uninstallKey.InstallLocation=${after.uninstallKey && after.uninstallKey.InstallLocation}`);
  record(`${label}: shortcuts target the isolated installed exe`, [after.startMenuLnk, after.desktopLnk].every((l) => l && l.target.toLowerCase() === app.toLowerCase()), `${after.startMenuLnk && after.startMenuLnk.target}`);
  record(`${label}: no Run-key / autostart entry created`, after.runKeyHits.length === 0);
  if (!existsSync(bridge) || !existsSync(app)) throw new Error('Install produced no executables; aborting cycle.');

  // 2. Hook settings (items 2/3) with the installed bridge as hook command.
  currentItem = layout === 'unicode' ? 'paths' : 'settings';
  const suite = await hookSettingsSuite(label, bridge, profile, projectRoot);
  if (full) await extraSettingsScenarios(label, bridge, profile, projectRoot);

  // 3. Launch hidden with a test profile; verify puzzle initialisation over CDP + SQLite.
  currentItem = 'install';
  const cdpPort = await freePort();
  const env = envFor(profile, { WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${cdpPort}` });
  const child = spawn(app, ['--hook-launch'], { env, stdio: 'ignore', windowsHide: false });
  let browser;
  const killApp = () => { try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* best effort */ } };
  try {
    const t0 = performance.now();
    while (!existsSync(join(profile, 'endpoint.json')) && child.exitCode === null && performance.now() - t0 < 30000) await sleep(100);
    record(`${label}: installed exe with --hook-launch published receiver endpoint`, existsSync(join(profile, 'endpoint.json')) && child.exitCode === null, `${Math.round(performance.now() - t0)} ms`);
    const endpoint = readJson(join(profile, 'endpoint.json'));
    record(`${label}: receiver bound to 127.0.0.1 and pid is the launched process`, endpoint.pid === child.pid && endpoint.protocolVersion === 1, `port=${endpoint.port}`);
    await sleep(1500);
    const vis = ps('visible', '-ProcessId', String(child.pid));
    const shown = userVisible(vis.windows);
    record(`${label}: --hook-launch shows no user-visible window (main window hidden)`, shown.length === 0 && vis.windows.some((w) => w.split('|')[2] === 'Clawdle' && w.endsWith('|hidden')), vis.windows.join(' ; '));
    const { chromium } = require('@playwright/test');
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
    const page = browser.contexts()[0].pages()[0];
    await page.getByRole('button', { name: 'Settings' }).waitFor({ timeout: 30000 });
    const tiles = await page.evaluate(() => [...document.querySelectorAll('[class*=tile]')].length);
    let rows = { games: [], daily: 0 };
    for (let i = 0; i < 40 && !rows.games.length; i++) { try { rows = gameRows(profile); } catch { /* best effort */ } if (!rows.games.length) await sleep(500); }
    record(`${label}: installed frontend rendered a puzzle grid (${tiles} tiles)`, tiles >= 30);
    record(`${label}: puzzle initialised and persisted (games row, playing status)`, rows.games.length >= 1 && rows.games.some(([, status]) => status === 'playing'), JSON.stringify(rows));
    await browser.close(); browser = null;
    record(`${label}: no files created in real %LOCALAPPDATA%\\org.clawdle.desktop`, countFiles(realAppDataDir) === preAppData, `before=${preAppData} after=${countFiles(realAppDataDir)}`);
    const state = ps('state');
    record(`${label}: launch created no Run-key and no new real AppData dir`, state.runKeyHits.length === 0 && !state.appDataDirs['LOCALAPPDATA\\Clawdle'] && !state.appDataDirs['APPDATA\\org.clawdle.desktop']);

    // 4. Run the handlers exactly as installed in settings (command + args) with spaces/Unicode paths.
    currentItem = layout === 'unicode' ? 'paths' : 'settings';
    const settingsNow = readJson(suite.s1.file);
    const sess = `acc-${layout}-${randomUUID()}`;
    const hs = ours(settingsNow, bridge).filter((x) => ['SessionStart', 'Stop'].includes(x.ev));
    for (const { ev, h } of hs) {
      let attempts = 0, rr;
      do { attempts++; rr = await runBridge(h.command, h.args, env, hookPayload(sess, ev)); }
      while (attempts < 3 && !journal(profile).some((j) => j[1] === sess && j[2] === ev));
      const delivered = journal(profile).some((j) => j[1] === sess && j[2] === ev);
      record(`${label}: installed ${ev} handler runs from its settings command+args and delivers`, rr.code === 0 && rr.stdout === 0 && rr.stderr === 0 && delivered, `${rr.ms.toFixed(0)} ms last run, attempts=${attempts}${attempts > 1 ? ' (first attempt not journaled: load)' : ''}`);
    }

    // 5/4. Delivery latency + malformed input with the receiver up.
    const n = full ? samples : 10;
    currentItem = 'delivery';
    const dsess = `acc-d-${layout}-${randomUUID()}`;
    const rounds = full ? 3 : 1; const roundStats = []; const runs = [];
    for (let k = 0; k < rounds; k++) {
      const cpu = settle();
      const rr = bench(bridge, ['hook', '--provider', 'claude'], env, Buffer.from(hookPayload(dsess)), { count: n, warmup: 5 });
      runs.push(...rr); roundStats.push({ round: k + 1, cpuBusyPctBefore: cpu, ...stats(rr.map((r) => r.ms)) });
    }
    const lat = runs.map((r) => r.ms); const bad = runs.filter((r) => r.code !== 0 || r.stdout || r.stderr || r.timedOut).length;
    measurements[`${label}.deliveryRounds`] = roundStats;
    const delivered = journal(profile).filter((j) => j[1] === dsess).length; const expectedDelivered = rounds * (5 + n);
    const st = stats(lat);
    measurements[`${label}.delivery`] = { lifetimeMs: stats(runs.map((r) => r.life)), ...st, warmups: 5, silentFailures: bad, deliveredOf: `${delivered}/${rounds * (5 + n)}`, samplesMs: lat.map((x) => +x.toFixed(1)) };
    record(`${label}: ${lat.length} warmed deliveries (${rounds} round(s) x ${n}) to running receiver all silent exit 0`, bad === 0, `p95=${st.p95} ms median=${st.median} max=${st.max}`);
    record(`${label}: every delivery journaled (no loss)`, delivered === expectedDelivered, `${delivered}/${expectedDelivered}`);
    if (full) {
      record(`${label}: running-receiver pooled p95 under 50 ms goal`, st.p95 < 50, `pooled p95=${st.p95} ms over ${lat.length}; per-round p95 ${roundStats.map((x) => x.p95).join('/')} ms; cpu busy before rounds ${roundStats.map((x) => x.cpuBusyPctBefore).join('/')}%`);
      record(`${label}: running-receiver max within hard 300 ms budget`, st.max <= 300, `max=${st.max} ms`);
    }

    currentItem = 'malformed';
    const jBefore = journal(profile).length;
    const malformed = await malformedBattery(`${label} receiver up`, bridge, env);
    record(`${label}: malformed input did not add journal events (receiver up)`, journal(profile).length === jBefore, `delta=${journal(profile).length - jBefore}`);
    measurements[`${label}.malformed.up`] = malformed;

    // Uninstall hooks now (app still running) to prove removal works alongside a live receiver.
    currentItem = layout === 'unicode' ? 'paths' : 'settings';
    await suite.finish();
  } finally {
    try { await browser?.close(); } catch { /* best effort */ }
    killApp();
    await sleep(1500);
  }

  // 6. Receiver down (app stopped, stale endpoint.json left behind).
  currentItem = 'receiver-down';
  record(`${label}: app process tree stopped`, mineOnly(ps('state').clawdleProcesses).length === 0);
  const stale = existsSync(join(profile, 'endpoint.json'));
  settle();
  const downN = full ? 30 : 10;
  const downRuns = bench(bridge, ['hook', '--provider', 'claude'], env0(profile), Buffer.from(hookPayload('acc-down')), { count: downN, warmup: 2 });
  const downLat = downRuns.map((r) => r.ms); const downBad = downRuns.filter((r) => r.code !== 0 || r.stdout || r.stderr || r.timedOut).length;
  const sd = stats(downLat);
  measurements[`${label}.receiverDown.staleEndpoint`] = { lifetimeMs: stats(downRuns.map((r) => r.life)), ...sd, staleEndpointFilePresent: stale, silentFailures: downBad, samplesMs: downLat.map((x) => +x.toFixed(1)) };
  record(`${label}: receiver down (stale endpoint) hook exits 0, silent, ${downN} runs`, downBad === 0, `max=${sd.max} ms p95=${sd.p95} ms`);
  record(`${label}: receiver down (stale endpoint) every run within 300 ms`, sd.max <= 300, `max=${sd.max} ms`);
  if (full) {
    const nodata = join(root, 'profile-empty'); mkdirSync(nodata);
    const runs2 = bench(bridge, ['hook', '--provider', 'claude'], envFor(nodata), Buffer.from(hookPayload('acc-down')), { count: downN, warmup: 2 });
    const lat2 = runs2.map((r) => r.ms); const bad2 = runs2.filter((r) => r.code !== 0 || r.stdout || r.stderr || r.timedOut).length;
    const s2 = stats(lat2);
    measurements[`${label}.receiverDown.noEndpoint`] = { ...s2, silentFailures: bad2, samplesMs: lat2.map((x) => +x.toFixed(1)) };
    record(`${label}: receiver down (no endpoint file, fresh profile) silent exit 0 within 300 ms`, bad2 === 0 && s2.max <= 300, `max=${s2.max} ms p95=${s2.p95} ms`);
    record(`${label}: receiver-down hook created no autostart state (no mailbox, no process)`, !existsSync(join(nodata, 'mailbox')) && mineOnly(ps('state').clawdleProcesses).length === 0);
    // Hung receiver: valid endpoint+token, a listener that accepts but never answers.
    const hung = join(root, 'profile-hung'); mkdirSync(hung);
    const token = createHash('sha256').update(randomUUID()).digest('hex');
    writeFileSync(join(hung, 'token'), token);
    const sockets = []; const server = net.createServer((s) => { sockets.push(s); s.on('error', () => {}); });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    writeFileSync(join(hung, 'endpoint.json'), JSON.stringify({ protocolVersion: 1, port: server.address().port, runtimeEpoch: randomUUID(), pid: 1, development: false }));
    const runs3 = bench(bridge, ['hook', '--provider', 'claude'], envFor(hung), Buffer.from(hookPayload('acc-hung')), { count: 15, warmup: 2 });
    const lat3 = runs3.map((r) => r.ms); const bad3 = runs3.filter((r) => r.code !== 0 || r.stdout || r.stderr || r.timedOut).length;
    sockets.forEach((s) => s.destroy()); server.close();
    const s3 = stats(lat3);
    measurements[`${label}.receiverHung`] = { lifetimeMs: stats(runs3.map((r) => r.life)), ...s3, silentFailures: bad3, samplesMs: lat3.map((x) => +x.toFixed(1)) };
    record(`${label}: hung receiver (accepts, never replies) silent exit 0`, bad3 === 0, `p95=${s3.p95} ms`);
    record(`${label}: hung receiver exits within 300 ms hard budget`, s3.max <= 300, `max=${s3.max} ms median=${s3.median} ms (bridge watchdog is 280 ms)`);
    const down = await malformedBattery(`${label} receiver down`, bridge, env0(profile));
    measurements[`${label}.malformed.down`] = down;
  }

  // 7. Uninstall.
  currentItem = 'install';
  const un = await runVerbatim(join(installDir, 'uninstall.exe'), '/S', 60000);
  let gone = false; const t1 = performance.now();
  while (performance.now() - t1 < 60000) { if (!ps('state').uninstallKey && !existsSync(app)) { gone = true; break; } await sleep(500); }
  await sleep(1500);
  const end = ps('state');
  measurements[`${label}.state.afterUninstall`] = end;
  const leftovers = existsSync(installDir) ? readdirSync(installDir) : [];
  record(`${label}: silent uninstall completed (launcher exit ${un.code}, files gone in ${Math.round(performance.now() - t1)} ms)`, gone);
  record(`${label}: uninstall removed uninstall key, Start menu and desktop shortcuts`, !end.uninstallKey && !end.startMenuLnk && !end.desktopLnk);
  if (end.manufacturerKey) observe(`${label}: silent uninstall leaves HKCU\\Software\\clawdle\\Clawdle behind (stock Tauri NSIS removes it only with the GUI 'Delete app data' box)`, `(Default)=${JSON.stringify(Object.values(end.manufacturerKey)[0])}`);
  else observe(`${label}: uninstall removed HKCU\\Software\\clawdle key`);
  // Remove our own test debris so the next cycle starts clean: only if the key points at this cycle's isolated install dir.
  if (end.manufacturerKey && Object.values(end.manufacturerKey).some((v) => v && v['(default)'] === installDir)) {
    execFileSync('reg', ['delete', 'HKCU\\Software\\clawdle', '/f'], { stdio: 'ignore' });
    measurements[`${label}.manufacturerKeyDebrisRemovedByHarness`] = true;
  }
  record(`${label}: install directory emptied of app files`, !existsSync(app) && !existsSync(bridge) && !existsSync(join(installDir, 'words')), `leftover entries: ${leftovers.join(', ') || 'none (directory removed)'}`);
  record(`${label}: uninstall left no Clawdle process or Run entry`, mineOnly(end.clawdleProcesses).length === 0 && end.runKeyHits.length === 0);
  record(`${label}: uninstall did not touch the test profile (kept for evidence)`, existsSync(join(profile, 'clawdle.sqlite')));
  return { installMs: inst.ms };
}
const env0 = (profile) => envFor(profile);

async function malformedBattery(label, bridge, env) {
  const big = Buffer.concat([Buffer.from('{"hook_event_name":"SessionStart","session_id":"x","pad":"'), Buffer.alloc(4 * 1024 * 1024 + 16, 0x61), Buffer.from('"}')]);
  const cases = [
    ['empty stdin', Buffer.alloc(0)],
    ['not JSON', Buffer.from('this is not json')],
    ['truncated JSON', Buffer.from('{"hook_event_name":"SessionStart","session_id":"abc"')],
    ['JSON array', Buffer.from('[]')],
    ['missing session_id', Buffer.from('{"hook_event_name":"SessionStart"}')],
    ['wrong field types', Buffer.from('{"hook_event_name":42,"session_id":{"a":1}}')],
    ['unknown event', Buffer.from('{"hook_event_name":"Bogus","session_id":"x"}')],
    ['invalid UTF-8', Buffer.from([0xff, 0xfe, 0xfd, 0x80, 0x00])],
    ['NUL bytes', Buffer.alloc(64, 0)],
    ['deeply nested JSON', Buffer.from('['.repeat(100000))],
    ['oversize (>4 MiB)', big],
  ];
  const out = [];
  for (const [name, bytes] of cases) {
    const runs = [];
    runs.push(...bench(bridge, ['hook', '--provider', 'claude'], env, bytes, { count: 3, warmup: 1, timeoutMs: 5000 }));
    const ok = runs.every((r) => r.code === 0 && r.stdout === 0 && r.stderr === 0 && !r.timedOut);
    const max = Math.max(...runs.map((r) => r.ms));
    out.push({ case: name, ok, maxMs: +max.toFixed(1), exits: runs.map((r) => r.code) });
    record(`${label}: malformed (${name}) -> exit 0, no stdout/stderr, ${max.toFixed(0)} ms max of 3`, ok && max <= 300, `max=${max.toFixed(1)} ms`);
  }
  // stdin held open and never closed: the bridge's own watchdog must end it.
  const held = [];
  held.push(...bench(bridge, ['hook', '--provider', 'claude'], env, Buffer.from('{"hook_event_name":"SessionStart"'), { count: 3, warmup: 1, closeStdin: false, timeoutMs: 5000 }));
  const hm = Math.max(...held.map((r) => r.ms));
  out.push({ case: 'stdin never closed', ok: held.every((r) => r.code === 0 && !r.stdout && !r.stderr && !r.timedOut), maxMs: +hm.toFixed(1) });
  record(`${label}: stdin held open -> bridge watchdog exit 0, silent, ${hm.toFixed(0)} ms max of 3`, held.every((r) => r.code === 0 && !r.stdout && !r.stderr && !r.timedOut) && hm <= 300, `max=${hm.toFixed(1)} ms`);
  return out;
}

// ---------------------------------------------------------------- main
async function main() {
  if (process.platform !== 'win32') throw new Error('Windows only.');
  if (!existsSync(installer)) throw new Error(`Installer not found: ${installer}. Build it with pnpm build:desktop in the main checkout.`);
  mkdirSync(evidenceDir, { recursive: true });
  const claudeSettings = join(os.homedir(), '.claude', 'settings.json');
  const claudeStatBefore = existsSync(claudeSettings) ? `${statSync(claudeSettings).mtimeMs}:${statSync(claudeSettings).size}` : 'absent';
  const env = {
    date: new Date().toISOString(),
    os: execFileSync('powershell', ['-NoProfile', '-Command', '$o=Get-CimInstance Win32_OperatingSystem; "$($o.Caption) $($o.Version) build $($o.BuildNumber).$((Get-ItemProperty \'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\').UBR)"'], { encoding: 'utf8' }).trim(),
    node: process.version,
    installer: { path: installer, bytes: statSync(installer).size, sha256: sha256(installer) },
    releaseBinaries: { desktop: sha256(join(releaseDir, 'clawdle-desktop.exe')), bridge: sha256(join(releaseDir, 'clawdle-bridge.exe')) },
    head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: mainCheckout, encoding: 'utf8' }).trim(),
    samples,
  };
  console.log(JSON.stringify(env, null, 2));
  await acquireLock();
  try {
    await cycle('plain', join(repo, '.local', `native-smoke-install-${tag}`), true);
    await cycle('unicode', join(repo, '.local', `native-smoke-install-ünï cödé dir ${tag}`), false);
    currentItem = 'safety';
    const claudeStatAfter = existsSync(claudeSettings) ? `${statSync(claudeSettings).mtimeMs}:${statSync(claudeSettings).size}` : 'absent';
    record('real ~/.claude/settings.json unchanged (mtime+size)', claudeStatBefore === claudeStatAfter);
    const final = ps('state');
    record('no Clawdle install state or process left on the machine', !final.uninstallKey && !final.manufacturerKey && !final.startMenuLnk && !final.desktopLnk && mineOnly(final.clawdleProcesses).length === 0);
  } catch (e) {
    record('script error', false, String(e && e.stack || e).slice(0, 600));
  } finally {
    for (const d of installedDirs) {
      try { if (existsSync(join(d, 'uninstall.exe'))) await runVerbatim(join(d, 'uninstall.exe'), '/S', 60000); } catch { /* best effort */ }
    }
    rmSync(lockPath, { force: true });
    const failed = results.filter((r) => !r.pass);
    writeFileSync(join(evidenceDir, 'result.json'), JSON.stringify({ env, results, observations, measurements }, null, 2));
    console.log(`\n${results.length - failed.length}/${results.length} checks passed; evidence: ${join(evidenceDir, 'result.json')}`);
    process.exitCode = failed.length ? 1 : 0;
  }
}
main();
