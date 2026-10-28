// Test-only snapshot and comparison. Never prints secret values.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
const [mode,root,output]=process.argv.slice(2);
const hash=f=>crypto.createHash('sha256').update(fs.readFileSync(path.join(root,f))).digest('hex');
const db=new DatabaseSync(path.join(root,'admin/gateway.sqlite'),{readOnly:true});
const s=JSON.parse(db.prepare('SELECT value FROM state WHERE id=1').get().value);
const snapshot={ca:hash('admin/ca/ca.key'),cert:hash('admin/ca/ca.crt'),totpKey:hash('admin/totp-encryption.key'),users:s.users.map(u=>({id:u.id,passwordHash:u.passwordHash})),devices:s.devices,certificates:s.certificates.map(c=>({id:c.id,serial:c.serial,status:c.status})),settings:s.settings};db.close();
if(mode==='save'){fs.writeFileSync(output,JSON.stringify(snapshot),{mode:0o600});console.log('Saved private persistence baseline.');}
else{const before=JSON.parse(fs.readFileSync(output));if(JSON.stringify(before)!==JSON.stringify(snapshot))throw new Error('Persistent identities, keys, certificates or settings changed');console.log('Persistence verified: CA/key, identities/password hashes, devices, certificate history, TOTP key and settings unchanged.');}
