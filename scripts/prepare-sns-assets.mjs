import { homedir } from 'node:os';
import { mkdir, cp, readdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const managed = 'midnight/sns/managed/sns';
const root = 'web/public/zk/sns';
await mkdir(`${root}/params`, {recursive:true});
for (const part of ['keys','zkir']) await cp(`${managed}/${part}`, `${root}/${part}`, {recursive:true});
// Public parameters only, copied from the project's isolated proof-server container.
for (const k of [13,16]) {
  const name = `bls_midnight_2p${k}`;
  try { await cp(`${process.env.SNS_PARAMS_DIR ?? `${homedir()}/.cache/midnight/zk-params`}/${name}`, `${root}/params/${name}`); }
  catch { execFileSync('docker',['cp',`${process.env.SNS_PROOF_CONTAINER ?? 'zkiss-sns-mvp-proof-server-1'}:/.cache/midnight/zk-params/${name}`,`${root}/params/`]); }
}
const assets=[];
for (const part of ['keys','zkir','params']) for (const name of await readdir(`${root}/${part}`)) {
 const bytes=await readFile(`${root}/${part}/${name}`);
 assets.push({path:`${part}/${name}`,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length});
}
await writeFile(`${root}/manifest.json`,JSON.stringify({protocolVersion:'zkiss-sns-v1',assets},null,2));
console.log('Prepared public SNS proof assets');
