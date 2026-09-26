import { ZKConfigProvider, createProofProvider, createProverKey, createVerifierKey, createZKIR } from '@midnight-ntwrk/midnight-js/types';
const asset = async (path: string) => {
  const r = await fetch('/midnight-assets/'+path);
  if (!r.ok) throw Error('PROOF_ASSET_UNAVAILABLE');
  return new Uint8Array(await r.arrayBuffer());
};
export class BrowserZkConfig extends ZKConfigProvider<string> {
  getProverKey(id:string) { return asset(`keys/${safe(id)}.prover`).then(createProverKey); }
  getVerifierKey(id:string) { return asset(`keys/${safe(id)}.verifier`).then(createVerifierKey); }
  getZKIR(id:string) { return asset(`zkir/${safe(id)}.bzkir`).then(createZKIR); }
}
const safe = (id:string) => { if(!/^[a-zA-Z0-9_]+$/.test(id)) throw Error('CIRCUIT_INVALID'); return id; };
let provider: ReturnType<typeof createProofProvider> | undefined;
export async function localProofProvider(_zk: BrowserZkConfig) {
  if(provider)return provider;
  const worker=new Worker(new URL('./proof-worker.ts',import.meta.url),{type:'module'});
  let nextId=0;
  const pending=new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void}>();
  worker.onmessage=({data})=>{const p=pending.get(data.id);if(!p)return;pending.delete(data.id);if(data.error)p.reject(Error(data.error));else p.resolve(data.result);};
  worker.onerror=()=>{for(const p of pending.values())p.reject(Error('LOCAL_PROVER_UNAVAILABLE'));pending.clear();};
  const invoke=(method:string,preimage:Uint8Array,key?:string,binding?:bigint)=>new Promise<any>((resolve,reject)=>{
    const id=++nextId;pending.set(id,{resolve,reject});worker.postMessage({id,method,preimage,key,binding});
  });
  provider=createProofProvider({check:(preimage,key)=>invoke('check',preimage,key),prove:(preimage,key,binding)=>invoke('prove',preimage,key,binding)});
  return provider;
}
