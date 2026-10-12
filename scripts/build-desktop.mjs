import { spawnSync } from 'node:child_process';
const offline=process.argv.includes('--offline');
function run(command,args,cwd=process.cwd()) {
  const result=spawnSync(command,args,{cwd,stdio:'inherit',shell:process.platform==='win32'});
  if(result.error)throw result.error;
  if(result.status!==0)process.exit(result.status??1);
}
run('cargo',['build','-p','clawdle-bridge','--release']);
run('pnpm',['--dir','apps/desktop','tauri','build','--config','src-tauri/tauri.release.conf.json',...(offline?['--config','src-tauri/tauri.offline.conf.json']:[])]);
