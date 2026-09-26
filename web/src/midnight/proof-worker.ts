// Dedicated device-local worker: private preimages cross only a structured-clone
// boundary, never an HTTP request. Asset requests contain no witness data.
const asset=async(path:string)=>{const r=await fetch('/midnight-assets/'+path);if(!r.ok)throw Error('PROOF_ASSET_UNAVAILABLE');return new Uint8Array(await r.arrayBuffer());};
let initialized:Promise<any>|undefined;
const initialize=()=>initialized??=(async()=>{
  const url='/midnight-assets/zkir.js';const glue=await import(/* @vite-ignore */url);
  const wasm=await WebAssembly.instantiate(await asset('zkir.wasm'),{'./midnight_zkir_wasm_bg.js':glue});
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
  catch {self.postMessage({id,error:'LOCAL_PROOF_FAILED'});}
  finally {preimage?.fill(0);}
};
export {};
