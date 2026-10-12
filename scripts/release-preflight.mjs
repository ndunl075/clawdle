import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
export function validateReleaseVersions({ packageVersion, tauriVersion, cargoVersion, tag }) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(packageVersion)) throw new Error('Product version must be a release SemVer');
  if (tauriVersion !== packageVersion || cargoVersion !== packageVersion) throw new Error(`Product versions disagree: package=${packageVersion}, Tauri=${tauriVersion}, Cargo=${cargoVersion}`);
  if (tag && tag !== `v${packageVersion}`) throw new Error(`Release tag ${tag} does not match product version v${packageVersion}`);
  return packageVersion;
}
export function releasePreflight(args = process.argv.slice(2)) {
  const packageVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  const tauriVersion = JSON.parse(readFileSync(join(root, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8')).version;
  const workspace = readFileSync(join(root, 'Cargo.toml'), 'utf8').split('[workspace.package]')[1]?.split(/^\[/m)[0];
  const cargoVersion = workspace?.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  const explicitTag = args.find(arg => arg.startsWith('--tag='))?.slice(6);
  const tag = explicitTag ?? (process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : undefined);
  if (args.includes('--require-tag') && !tag) throw new Error('Release packaging requires an explicit version tag');
  if (args.includes('--require-windows') && (process.platform !== 'win32' || process.arch !== 'x64')) throw new Error('This release packages Windows x64 only');
  const version = validateReleaseVersions({ packageVersion, tauriVersion, cargoVersion, tag });
  const result = spawnSync(process.execPath, [join(root, 'scripts/licenses-generate.mjs'), '--check'], { cwd: root, stdio: 'inherit' });
  if (result.error || result.status !== 0) throw new Error('Dependency notices must verify against current lockfiles before packaging');
  console.log(`Release preflight passed for Clawdle ${version}${tag ? ` (${tag})` : ''}`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) releasePreflight();
