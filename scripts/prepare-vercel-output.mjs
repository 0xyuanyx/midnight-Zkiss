import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

// Deploy only the browser build and public proving assets, never backend secrets.
const root = resolve(import.meta.dirname, '..');
const dist = resolve(root, 'web/dist');
const output = resolve(root, '.vercel/output');
const manifest = JSON.parse(await readFile(`${dist}/zk/sns/manifest.json`, 'utf8'));
if (manifest.protocolVersion !== 'zkiss-sns-v1' || !manifest.assets.length) {
  throw new Error('Run npm run prepare:sns-assets before building');
}
for (const asset of manifest.assets) {
  if (!/^(keys|zkir|params)\/[\w.-]+$/.test(asset.path)) throw new Error('Invalid proof asset path');
  const bytes = await readFile(`${dist}/zk/sns/${asset.path}`);
  if (bytes.length !== asset.bytes || createHash('sha256').update(bytes).digest('hex') !== asset.sha256) {
    throw new Error(`Proof asset mismatch: ${asset.path}`);
  }
}

const configuredOrigin = process.env.ZKISS_API_ORIGIN;
let origin;
if (configuredOrigin) {
  const url = new URL(configuredOrigin);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || /^(localhost|127\.|\[::1\])/.test(url.hostname)) {
    throw new Error('ZKISS_API_ORIGIN must be a public HTTPS origin without credentials or path');
  }
  origin = url.origin;
}

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(dist, `${output}/static`, { recursive: true });
await writeFile(`${output}/static/api-unavailable.json`, JSON.stringify({
  error: { code: 'SERVICE_NOT_CONFIGURED', fields: [], retryable: false },
}));
await writeFile(`${output}/config.json`, JSON.stringify({
  version: 3,
  routes: [
    origin
      ? { src: '/api/(.*)', dest: `${origin}/api/$1`, headers: { 'Cache-Control': 'no-store' } }
      : { src: '/api(?:/.*)?', dest: '/api-unavailable.json', status: 503, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } },
    { src: '/zk/(.*)', headers: { 'Cache-Control': 'public, max-age=0, must-revalidate' }, continue: true },
    { handle: 'filesystem' },
    { src: '/(?:assets|zk)/.*', status: 404 },
    { src: '/.*', dest: '/index.html', headers: { 'Cache-Control': 'no-cache' } },
  ],
}, null, 2));
console.log(`Vercel output ready: ${origin ? 'public API proxy configured' : 'frontend only; API returns 503'}`);
