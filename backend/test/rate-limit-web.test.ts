import { test, expect } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { buildApp } from '../src/app.js';
import { localConfig } from '../src/config.js';
import { registerWeb } from '../src/web-serving.js';

test('static and SPA requests do not consume API quota; API remains limited', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zkiss-limit-'));
  const app = await buildApp({ pool: {} as Pool, config: localConfig });
  try {
    await writeFile(join(root, 'index.html'), '<html>app</html>');
    await writeFile(join(root, 'app.js'), '/* asset */');
    app.get('/api/v1/quota-probe', async () => ({ ok: true }));
    await registerWeb(app, root);
    for (let i = 0; i < 305; i++) {
      expect((await app.inject(i % 2 ? '/app.js' : '/home')).statusCode).toBe(200);
    }
    for (let i = 0; i < 300; i++) {
      expect((await app.inject('/api/v1/quota-probe')).statusCode).toBe(200);
    }
    expect((await app.inject('/api/v1/quota-probe')).statusCode).toBe(429);
    expect((await app.inject('/home')).statusCode).toBe(200);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
