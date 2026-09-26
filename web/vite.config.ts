import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import wasm from 'vite-plugin-wasm';
import { readFile, mkdir, copyFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
const repo=resolve(import.meta.dirname,'..');
const assets=resolve(repo,'midnight/contract/managed/zkiss');
function publicProofAssets(params:string):Plugin {
  const file=(path:string):string|null=>{
    if(path==='zkir.js')return resolve(repo,'node_modules/@midnight-ntwrk/zkir-v2/midnight_zkir_wasm_bg.js');
    if(path==='zkir.wasm')return resolve(repo,'node_modules/@midnight-ntwrk/zkir-v2/midnight_zkir_wasm_bg.wasm');
    if(/^bls_midnight_2p\d{1,2}$/.test(path))return resolve(params,path);
    if(/^(keys\/[a-zA-Z0-9_]+\.(prover|verifier)|zkir\/[a-zA-Z0-9_]+\.bzkir)$/.test(path))return resolve(assets,path);
    return null;
  };
  return {name:'zkiss-public-proof-assets',
    configureServer(server){server.middlewares.use('/midnight-assets',async(req,res)=>{
      const name=(req.url??'').split('?')[0].replace(/^\//,'');const target=file(name);
      if(req.method!=='GET'||!target){res.statusCode=404;res.end();return;}
      try {const data=await readFile(target);res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':name.endsWith('.wasm')?'application/wasm':'application/octet-stream');res.end(data);}
      catch{res.statusCode=404;res.end('Proof asset unavailable');}
    });},
    async closeBundle(){
      const out=resolve(import.meta.dirname,'dist/midnight-assets');
      for(const sub of ['keys','zkir']) {await mkdir(resolve(out,sub),{recursive:true});for(const name of await readdir(resolve(assets,sub)))await copyFile(resolve(assets,sub,name),resolve(out,sub,name));}
      for(const name of ['zkir.js','zkir.wasm',...(await readdir(params)).filter(x=>/^bls_midnight_2p\d{1,2}$/.test(x))])await copyFile(file(name)!,resolve(out,name));
    },
  };
}
export default defineConfig(({mode})=>{
  // Only VITE_ variables are exposed to the browser; these values configure Node-side tooling.
  const env=loadEnv(mode,import.meta.dirname,'');
  const params=env.ZK_PARAMS_DIR || resolve(homedir(),'.cache/midnight/zk-params');
  const proxy={
    '/api':{target:env.ZKISS_API_TARGET||'http://127.0.0.1:3001',changeOrigin:true},
    '/midnight-indexer':{target:env.MIDNIGHT_INDEXER_ORIGIN||'http://127.0.0.1:8088',changeOrigin:true,ws:true,rewrite:(path:string)=>path.replace(/^\/midnight-indexer/,'')},
  };
  return {
  define:{'process.env.NODE_DEBUG':'false'},
  plugins:[react(),wasm(),publicProofAssets(params)],
  resolve:{alias:{'isomorphic-ws':resolve(import.meta.dirname,'src/midnight/websocket.ts'),assert:resolve(repo,'node_modules/assert/build/assert.js')},dedupe:['@midnight-ntwrk/compact-runtime','@midnight-ntwrk/ledger-v8','@midnight-ntwrk/onchain-runtime-v3']},
  optimizeDeps:{include:['@hpke/core','@midnight-ntwrk/compact-js','@midnight-ntwrk/compact-runtime','@midnight-ntwrk/midnight-js-indexer-public-data-provider','@midnight-ntwrk/midnight-js/contracts','@midnight-ntwrk/midnight-js/network-id','@midnight-ntwrk/midnight-js/types'],exclude:['@midnight-ntwrk/ledger-v8','@midnight-ntwrk/onchain-runtime-v3']},
  build:{target:'esnext'},
  server:{proxy},
  preview:{proxy},
};
});
