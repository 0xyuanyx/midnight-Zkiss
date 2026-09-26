// Dedicated device-local worker: private preimages cross only a structured-clone
// boundary, never an HTTP request. Asset requests contain no witness data.
const assets=new Map<string,Promise<Uint8Array>>();
const asset=(path:string):Promise<Uint8Array>=>{
  const cached=assets.get(path);if(cached)return cached;
  const pending=(async()=>{
    for(let attempt=0;attempt<3;attempt++){
      try {
        const r=await fetch('/midnight-assets/'+path,{signal:AbortSignal.timeout(30000)});
        if(!r.ok)throw Error('PROOF_ASSET_UNAVAILABLE');
        return new Uint8Array(await r.arrayBuffer());
      } catch(error) {
        if(attempt===2)throw Error('PROOF_ASSET_UNAVAILABLE');
        await new Promise(resolve=>setTimeout(resolve,500*(attempt+1)));
      }
    }
    throw Error('PROOF_ASSET_UNAVAILABLE');
  })();
  assets.set(path,pending);
  pending.catch(()=>{if(assets.get(path)===pending)assets.delete(path);});
  return pending;
};
let initialized:Promise<any>|undefined;
const initialize=()=>initialized??=(async()=>{
  const url='/midnight-assets/zkir.js';const glue=await import(/* @vite-ignore */url);
  const wasm=await WebAssembly.instantiate((await asset('zkir.wasm')).buffer as ArrayBuffer,{'./midnight_zkir_wasm_bg.js':glue});
  glue.__wbg_set_wasm(wasm.instance.exports);(wasm.instance.exports.__wbindgen_start as ()=>void)();
  return glue.provingProvider({lookupKey:async(id:string|undefined)=>{
    if(id===undefined)return undefined;
    if(!/^[a-zA-Z0-9_]+$/.test(id))throw Error('CIRCUIT_INVALID');
    const [proverKey,verifierKey,ir]=await Promise.all([asset(`keys/${id}.prover`),asset(`keys/${id}.verifier`),asset(`zkir/${id}.bzkir`)]);
    return {proverKey,verifierKey,ir};
  },getParams:(k:number)=>asset('bls_midnight_2p'+k)});
})();
self.onmessage=async(event:MessageEvent)=>{
  const {id,method,preimage,key,binding}=event.data;
  try {const p=await initialize();const result=await p[method](preimage,key,binding);self.postMessage({id,result});}
  catch(error) {self.postMessage({id,error:error instanceof Error&&error.message==='PROOF_ASSET_UNAVAILABLE'?'PROOF_ASSET_UNAVAILABLE':'LOCAL_PROOF_FAILED'});}
  finally {preimage?.fill(0);}
};
export {};
