// Loopback-only diagnostic fixture server. No private user data or POST routes.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import ts from 'typescript';
const repo = resolve(import.meta.dirname, '../../..');
const fixed = {
  '/': [resolve(import.meta.dirname, 'index.html'), 'text/html'],
  '/worker.js': [resolve(import.meta.dirname, 'worker.js'), 'text/javascript'],
  '/zkir.js': [resolve(repo, 'node_modules/@midnight-ntwrk/zkir-v2/midnight_zkir_wasm_bg.js'), 'text/javascript'],
  '/zkir.wasm': [resolve(repo, 'node_modules/@midnight-ntwrk/zkir-v2/midnight_zkir_wasm_bg.wasm'), 'application/wasm'],
};
const params = process.env.ZK_PARAMS_DIR;
if (!params) throw Error('ZK_PARAMS_DIR_REQUIRED');
createServer(async (req, res) => {
  if (req.method !== 'GET') { res.writeHead(405).end(); return; }
  const path = new URL(req.url, 'http://localhost').pathname;
  if (path === '/device-store.js') { const source = await readFile(resolve(repo,'web/src/midnight/device-store.ts'),'utf8'); res.writeHead(200,{'Content-Type':'text/javascript'}).end(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText); return; }
  let entry = fixed[path];
  if (/^\/(preimage|proverKey|verifierKey|ir)\.bin$/.test(path) || path === '/fixture.json') entry = [resolve(repo, 'backend/reports/browser-probe', path.slice(1)), 'application/octet-stream'];
  if (/^\/bls_midnight_2p\d{1,2}$/.test(path)) entry = [resolve(params, path.slice(1)), 'application/octet-stream'];
  if (!entry) { res.writeHead(404).end(); return; }
  try { const data = await readFile(entry[0]); res.writeHead(200, { 'Content-Type': entry[1], 'Cache-Control': 'no-store' }); res.end(data); }
  catch { res.writeHead(404).end(); }
}).listen(3117, '127.0.0.1', () => console.log('Browser probe http://127.0.0.1:3117'));
