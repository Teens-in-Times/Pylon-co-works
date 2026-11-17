// Assemble only runtime files and notices, never source PSDs, caches or test logs.
import {readFile,readdir,mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {zipSync} from 'fflate';
import './build.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const files=new Map();
const add=async name=>files.set(name,await readFile(path.join(root,name)));
for(const name of ['pylon-plugin.json','README.md','THIRD_PARTY_NOTICES.md','dist/index.js','dist/live2d-player.js'])await add(name);
async function tree(name){
  for(const entry of (await readdir(path.join(root,name),{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
    const relative=`${name}/${entry.name}`;
    if(entry.isSymbolicLink())throw new Error(`Symlink not allowed: ${relative}`);
    if(entry.isDirectory())await tree(relative);
    else if(entry.isFile()&&!entry.name.endsWith('-validation.json'))await add(relative);
  }
}
await tree('dist/art');await tree('dist/licenses');
const sha=b=>createHash('sha256').update(b).digest('hex');
const manifest=JSON.parse(files.get('pylon-plugin.json'));
const inventory=[...files].sort(([a],[b])=>a.localeCompare(b)).map(([name,data])=>({path:name,bytes:data.length,sha256:sha(data)}));
const inventoryBytes=Buffer.from(JSON.stringify({id:manifest.id,version:manifest.version,files:inventory},null,2));
const name=`agent-operations-${manifest.version}-${sha(inventoryBytes).slice(0,12)}`;
files.set('FILES.sha256.json',inventoryBytes);
const output=path.join(root,'release',name);await mkdir(output,{recursive:true});
for(const [relative,data] of files){const target=path.join(output,relative);await mkdir(path.dirname(target),{recursive:true});await writeFile(target,data);}
const zip=zipSync(Object.fromEntries([...files].map(([key,data])=>[key,[new Uint8Array(data),{level:key.endsWith('.png')?0:6,mtime:new Date('2026-01-01T00:00:00Z')}]])));
const zipPath=`${output}.zip`;await writeFile(zipPath,zip);await writeFile(`${zipPath}.sha256`,`${sha(zip)}  ${name}.zip\n`);
console.log(JSON.stringify({directory:output,zip:zipPath,bytes:zip.length,files:files.size,sha256:sha(zip)},null,2));
