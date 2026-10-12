import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = join(root, 'assets/licenses');
const inventoryPath = join(directory, 'inventory.json');
const outputPath = join(directory, 'DEPENDENCIES.md');
const check = process.argv.includes('--check');
const refresh = process.argv.includes('--refresh');
const sha = content => createHash('sha256').update(content).digest('hex');
const canonical = content => content.replaceAll('\r\n', '\n');
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const key = entry => `${entry.name}@${entry.version}`;
const order = (a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0;
const locks = Object.fromEntries(['pnpm-lock.yaml', 'Cargo.lock'].map(name => [name, canonical(readFileSync(join(root, name), 'utf8'))]));
const lockChecksums = Object.fromEntries(Object.entries(locks).map(([name, content]) => [name, sha(content)]));
const required = [];
const npmPackages = locks['pnpm-lock.yaml'].split(/^packages:\n/m)[1]?.split(/^snapshots:\n/m)[0];
if (!npmPackages) throw new Error('Unsupported pnpm lockfile: expected packages and snapshots');
for (const match of npmPackages.matchAll(/^ {2}('[^']+'|[^\s:][^:]*):\n([\s\S]*?)(?=^ {2}(?:'[^']+'|[^\s:][^:]*):\n|$(?![\s\S]))/gm)) {
  const packageKey = match[1].replace(/^'|'$/g, '');
  const at = packageKey.lastIndexOf('@');
  const integrity = match[2].match(/integrity: ([^}\s,]+)/)?.[1];
  if (at <= 0 || !integrity) throw new Error(`Unsupported npm package resolution: ${packageKey}`);
  required.push({ name: packageKey.slice(0, at), version: packageKey.slice(at + 1), integrity });
}
for (const block of locks['Cargo.lock'].split('[[package]]').slice(1)) {
  const field = name => block.match(new RegExp(`^${name} = "([^"]+)"$`, 'm'))?.[1];
  if (!field('source')) continue;
  if (!field('source').startsWith('registry+')) throw new Error('Add explicit provenance handling for Git Cargo dependencies');
  if (!field('checksum')) throw new Error('Missing Cargo checksum');
  required.push({ name: `crate:${field('name')}`, version: field('version'), integrity: `sha256-${field('checksum')}` });
}
required.sort(order);
if (!required.length || new Set(required.map(key)).size !== required.length) throw new Error('Empty or duplicate dependency inventory');

const previous = existsSync(inventoryPath) ? JSON.parse(readFileSync(inventoryPath, 'utf8')) : null;
const stored = new Map((previous?.packages ?? []).map(entry => [key(entry), entry]));
const overridesPath = join(directory, 'overrides.json');
const overrides = existsSync(overridesPath) ? JSON.parse(readFileSync(overridesPath, 'utf8')) : {};
const local = new Map();

function retainNotice(text, sourceUrl, originalFile) {
  const bytes = Buffer.from(canonical(text));
  const checksum = sha(bytes);
  const file = `notice-${checksum}.txt`;
  if (!check) writeFileSync(join(directory, file), bytes);
  return { file, sha256: checksum, sourceUrl, originalFile };
}
function capture(name, version, license, repository, packageDirectory, sourceUrl, licenseFile) {
  const files = readdirSync(packageDirectory).filter(file => /^(licen[cs]e|copying|copyright|notice)([.\-_]|$)/i.test(file) && !file.endsWith('.json')).sort();
  if (licenseFile && !files.includes(licenseFile)) files.push(licenseFile);
  const notices = files.flatMap(file => {
    try { return [retainNotice(readFileSync(resolve(packageDirectory, file), 'utf8'), `${sourceUrl}#${encodeURIComponent(file)}`, file)]; }
    catch { return []; }
  });
  local.set(`${name}@${version}`, { name, version, license: typeof license === 'string' ? license : license?.type ?? '', repository: typeof repository === 'string' ? repository : repository?.url ?? '', notices });
}
function captureInstalled() {
  let search = root;
  while (!existsSync(join(search, 'node_modules/.pnpm')) && dirname(search) !== search) search = dirname(search);
  const store = join(search, 'node_modules/.pnpm');
  if (existsSync(store)) for (const entry of readdirSync(store, { withFileTypes: true })) {
    const modules = join(store, entry.name, 'node_modules');
    if (!entry.isDirectory() || !existsSync(modules)) continue;
    for (const module of readdirSync(modules)) {
      const bases = module.startsWith('@') ? readdirSync(join(modules, module)).map(child => join(modules, module, child)) : [join(modules, module)];
      for (const base of bases) {
        if (!existsSync(join(base, 'package.json'))) continue;
        const data = JSON.parse(readFileSync(join(base, 'package.json'), 'utf8'));
        if (!data.name || local.has(`${data.name}@${data.version}`)) continue;
        const filename = data.name.split('/').at(-1);
        capture(data.name, data.version, data.license, data.repository, base, `https://registry.npmjs.org/${data.name}/-/${filename}-${data.version}.tgz`);
      }
    }
  }
  const result = spawnSync(process.env.CARGO ?? 'cargo', ['metadata', '--format-version', '1', '--locked', '--offline'], { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`Cargo metadata failed; fetch pinned dependencies first: ${result.error?.message ?? result.stderr}`);
  for (const data of JSON.parse(result.stdout).packages) if (data.source) {
    const packageDirectory = dirname(data.manifest_path);
    capture(`crate:${data.name}`, data.version, data.license, data.repository, packageDirectory, `https://static.crates.io/crates/${data.name}/${data.name}-${data.version}.crate`, data.license_file);
  }
}
if (!check && (refresh || required.some(entry => !stored.has(key(entry))))) { mkdirSync(directory, { recursive: true }); captureInstalled(); }

const packages = required.map(dependency => {
  const id = key(dependency);
  const prior = stored.get(id);
  const candidate = refresh ? local.get(id) ?? prior : prior ?? local.get(id);
  const override = overrides[id];
  const entry = candidate ? { ...candidate } : override ? { name: dependency.name, version: dependency.version, license: override.license, repository: override.repository ?? '', notices: [] } : null;
  if (!entry) throw new Error(`Missing metadata for ${id}; run --refresh after installing pinned dependencies, or add a reviewed override`);
  if (prior?.integrity && prior.integrity !== dependency.integrity) throw new Error(`Published package integrity changed for ${id}`);
  if (override) {
    if (!override.reason || !Array.isArray(override.notices) || !override.notices.length) throw new Error(`Invalid maintained override for ${id}`);
    entry.notices = override.notices;
    entry.overrideReason = override.reason;
    if (override.repository) entry.repository = override.repository;
  }
  if (entry.overrideReason && !override) throw new Error(`Missing maintained notice-location override for ${id}`);
  if (!entry.license || !Array.isArray(entry.notices) || !entry.notices.length) throw new Error(`Missing full license notice for ${id}; add a reviewed, sourced override instead of metadata-only attribution`);
  for (const notice of entry.notices) {
    if (!/^notice-[a-f0-9]{64}\.txt$/.test(notice.file) || !/^https:\/\//.test(notice.sourceUrl) || !notice.originalFile || !/^[a-f0-9]{64}$/.test(notice.sha256)) throw new Error(`Invalid notice provenance for ${id}`);
    if (sha(readFileSync(join(directory, notice.file))) !== notice.sha256) throw new Error(`Notice checksum mismatch for ${id}: ${notice.file}`);
  }
  return { name: entry.name, version: entry.version, integrity: dependency.integrity, license: entry.license, repository: entry.repository, ...(entry.overrideReason ? { overrideReason: entry.overrideReason } : {}), notices: entry.notices };
});
const inventory = { format: 'clawdle-dependency-notices', version: 1, lockChecksums, packages };
const markdown = '# Dependency licenses\n\nGenerated from all pinned npm and Cargo lockfile packages, including optional platform and development dependencies. Full notices are retained locally with source URLs and SHA-256 checksums. Run `node scripts/licenses-generate.mjs --check` to verify offline.\n\n' + packages.map(entry => `## ${entry.name} ${entry.version}\n\nLicense: ${entry.license}\n\n${entry.repository ? `Upstream: ${entry.repository}\n\n` : ''}${entry.overrideReason ? `Notice location override: ${entry.overrideReason}\n\n` : ''}${entry.notices.map(notice => `### ${notice.originalFile}\n\nSource: ${notice.sourceUrl}\n\nSHA-256: \`${notice.sha256}\`\n\n\`\`\`text\n${readFileSync(join(directory, notice.file), 'utf8').trimEnd()}\n\`\`\``).join('\n\n')}`).join('\n\n') + '\n';
if (check) {
  if (!previous || json(previous) !== json(inventory)) throw new Error('License inventory is stale for current lockfiles; regenerate and review notices');
  if (!existsSync(outputPath) || readFileSync(outputPath, 'utf8') !== markdown) throw new Error('Dependency notice document is stale');
  console.log(`Verified ${packages.length} dependency notices against current lockfiles`);
} else {
  writeFileSync(inventoryPath, json(inventory));
  writeFileSync(outputPath, markdown);
  console.log(`Wrote ${packages.length} complete dependency notices`);
}
