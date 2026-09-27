import { readFileSync } from 'node:fs';
import wasm from 'vite-plugin-wasm';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return { plugins: [react(), wasm()], resolve: { dedupe: ['@midnight-ntwrk/compact-runtime', '@midnight-ntwrk/ledger-v8', '@midnight-ntwrk/onchain-runtime-v3', '@hpke/core', 'object-inspect'], alias: { 'assert': 'assert/' } }, build: { target: 'esnext' }, worker: { format: 'es', plugins: () => [wasm()] }, optimizeDeps: { include: ['object-inspect', 'assert/'], exclude: ['@midnight-ntwrk/zkir-v2', '@midnight-ntwrk/ledger-v8', '@midnight-ntwrk/compact-runtime', '@midnight-ntwrk/onchain-runtime-v3'] }, server: { https: env.LOCAL_TLS_CERT && env.LOCAL_TLS_KEY ? { cert: readFileSync(env.LOCAL_TLS_CERT), key: readFileSync(env.LOCAL_TLS_KEY) } : undefined, proxy: { '/api': { target: env.ZKISS_API_TARGET || env.API_PROXY_TARGET || 'http://127.0.0.1:3001', changeOrigin: false } } } };
});
