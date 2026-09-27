import { test, expect } from 'vitest';
import { fixture } from './helpers.js';
import { localConfig } from '../src/config.js';
import { demoMidnight } from '../src/adapters/demo-midnight.js';
import { ensureDefaultEvent } from '../src/default-event.js';

test('SNS-only mode admits normally and refuses all ticket/admission work', async () => {
  const f = await fixture('demo', { config: { ...localConfig, admissionMode: 'open', snsOnly: true, defaultEventId: 'evt' }, midnight: demoMidnight });
  try {
    const response = await f.app.inject({ method: 'POST', url: '/api/v1/sessions', payload: { devicePublicKey: Buffer.alloc(32, 3).toString('base64') } });
    expect(response.statusCode).toBe(201);
    const me = response.json().data;
    expect(me.admissionStatus).toBe('active');
    const headers = { cookie: response.cookies.map(c => `${c.name}=${c.value}`).join('; '), 'x-csrf-token': me.csrfToken, 'idempotency-key': 'ticket-test' };
    const ticket = await f.app.inject({ method: 'POST', url: '/api/v1/events/evt/midnight/ticket', headers, payload: { ticketLeaf: 'a'.repeat(64) } });
    expect(ticket.json().error.code).toBe('ADMISSION_DISABLED');
    const admission = await f.app.inject({ method: 'POST', url: '/api/v1/events/evt/chain-intents', headers: {...headers, 'idempotency-key':'admit-test'}, payload: { purpose:'admission',devicePublicKey: Buffer.alloc(32,3).toString('base64'), deviceKeyVersion:1 } });
    expect(admission.json().error.code).toBe('ADMISSION_DISABLED');
    expect((await f.pool.query('SELECT count(*)::int AS n FROM chain_jobs')).rows[0].n).toBe(0);
    expect((await f.pool.query('SELECT count(*)::int AS n FROM chain_intents')).rows[0].n).toBe(0);
  } finally { await f.close(); }
});
test('shared database startup opt-out creates no implicit event', async () => {
  const f = await fixture();
  try {
    await ensureDefaultEvent(f.pool, { ...localConfig, admissionMode:'open',autoCreateEvent:false,defaultEventId:'must_not_exist' });
    expect((await f.pool.query("SELECT count(*)::int AS n FROM events WHERE id='must_not_exist'")).rows[0].n).toBe(0);
  } finally { await f.close(); }
});
