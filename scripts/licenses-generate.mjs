import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
const root=process.cwd();
const inventory=[];
function add(name,version,license,repository,directory) {
  const notices=readdirSync(directory).filter(file=>/^(licen[cs]e|copying|copyright|notice)([.\-_]|$)/i.test(file)).filter(file=>!file.endsWith('.json')).flatMap(file=>{
    try {const text=readFileSync(join(directory,file),'utf8');return [`#### ${file}\n\n\`\`\`text\n${text.trim()}\n\`\`\``];}catch{return [];}
  });
  inventory.push({name,version,license:license??'See upstream notice',repository:typeof repository==='string'?repository:repository?.url??'',notices});
}
for(const entry of readdirSync(join(root,'node_modules/.pnpm'),{withFileTypes:true})) {
  if(!entry.isDirectory())continue;
  const modules=join(root,'node_modules/.pnpm',entry.name,'node_modules');
  if(!existsSync(modules))continue;
  for(const module of readdirSync(modules)) {
    const bases=module.startsWith('@')?readdirSync(join(modules,module)).map(child=>join(modules,module,child)):[join(modules,module)];
    for(const directory of bases) {
      const manifest=join(directory,'package.json');if(!existsSync(manifest))continue;
      const data=JSON.parse(readFileSync(manifest,'utf8'));
      if(!data.name||inventory.some(item=>item.name===data.name&&item.version===data.version))continue;
      add(data.name,data.version,data.license,data.repository,directory);
    }
  }
}
const result=spawnSync('cargo',['metadata','--format-version','1','--locked'],{encoding:'utf8',maxBuffer:32*1024*1024,shell:process.platform==='win32'});
if(result.status!==0)throw new Error(`Cargo metadata failed: ${result.stderr}`);
for(const data of JSON.parse(result.stdout).packages) {
  if(!data.source)continue;
  add(`crate:${data.name}`,data.version,data.license,data.repository,dirname(data.manifest_path));
}
inventory.sort((a,b)=>a.name.localeCompare(b.name)||a.version.localeCompare(b.version));
const text='# Dependency licenses\n\nGenerated from the pinned npm and Cargo dependencies. Includes development dependencies conservatively.\n\n'+inventory.map(item=>`## ${item.name} ${item.version}\n\nLicense: ${item.license}\n\n${item.repository?`Upstream: ${item.repository}\n\n`:''}${item.notices.join('\n\n')||'License text is declared by upstream package metadata; consult the source repository.'}`).join('\n\n')+'\n';
const output=join(root,'assets/licenses/DEPENDENCIES.md');writeFileSync(output,text.replaceAll('\r\n','\n'));
console.log(`Wrote ${inventory.length} dependency notices to ${relative(root,output)}`);
