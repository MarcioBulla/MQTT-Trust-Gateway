import fs from 'node:fs';
import path from 'node:path';
const root=path.resolve('admin-web/node_modules'),packages=[];
function read(dir){
 const file=path.join(dir,'package.json');
 if(fs.existsSync(file)){const p=JSON.parse(fs.readFileSync(file));packages.push({name:p.name,version:p.version,license:p.license||'UNKNOWN',repository:typeof p.repository==='object'?p.repository.url:p.repository});}
 const nested=path.join(dir,'node_modules');if(fs.existsSync(nested)) scan(nested);
}
function scan(dir){for(const item of fs.readdirSync(dir,{withFileTypes:true})){if(!item.isDirectory()||item.name.startsWith('.'))continue;const d=path.join(dir,item.name);if(item.name.startsWith('@')){for(const name of fs.readdirSync(d))read(path.join(d,name));}else read(d)}}
scan(root);packages.sort((a,b)=>(a.name+a.version).localeCompare(b.name+b.version));
fs.writeFileSync('THIRD_PARTY_LICENSES.json',JSON.stringify({note:'Installed dependency manifest, including development dependencies. Mosquitto is distributed under BSD-3-Clause OR EPL-2.0; this project uses the BSD-3-Clause option. Node.js and Bun have MIT licenses; container OS components retain their individual licenses.',packages},null,2)+'\n');
const counts={};for(const p of packages)counts[p.license]=(counts[p.license]||0)+1;console.log(counts);
