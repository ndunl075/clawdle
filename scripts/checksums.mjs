import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const directory=process.argv[2];
if(!directory)throw new Error('Pass a release artifact directory');
const files=readdirSync(directory).filter(name=>name.endsWith('.exe')).sort();
if(!files.length)throw new Error('No installer artifacts found');
writeFileSync(join(directory,'SHA256SUMS.txt'),files.map(name=>`${createHash('sha256').update(readFileSync(join(directory,name))).digest('hex')}  ${name}`).join('\n')+'\n');
