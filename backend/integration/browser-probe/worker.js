import * as glue from './zkir.js';
const bytes = async path => { const r = await fetch(path); if (!r.ok) throw Error(`Asset ${path}: ${r.status}`); return new Uint8Array(await r.arrayBuffer()); };
self.onmessage = async () => {
  try {
    const started = performance.now();
    const instance = await WebAssembly.instantiate(await bytes('/zkir.wasm'), { './midnight_zkir_wasm_bg.js': glue });
    glue.__wbg_set_wasm(instance.instance.exports);
    instance.instance.exports.__wbindgen_start();
    const fixture = await (await fetch('/fixture.json')).json();
    if (fixture.synthetic !== true) throw Error('SYNTHETIC_FIXTURE_REQUIRED');
    const [pre, proverKey, verifierKey, ir] = await Promise.all(['preimage','proverKey','verifierKey','ir'].map(n => bytes('/'+n+'.bin')));
    const provider = glue.provingProvider({ lookupKey: async key => key === fixture.circuit ? {proverKey, verifierKey, ir} : undefined, getParams: k => bytes('/bls_midnight_2p'+k) });
    await provider.check(pre, fixture.circuit);
    self.postMessage({ status: 'checked' });
    const proof = await provider.prove(pre, fixture.circuit, fixture.binding === undefined ? undefined : BigInt(fixture.binding));
    self.postMessage({ status: 'proved', bytes: proof.byteLength, ms: Math.round(performance.now()-started) });
  } catch (e) { self.postMessage({ status: 'failed', error: String(e.stack ?? e) }); }
};
