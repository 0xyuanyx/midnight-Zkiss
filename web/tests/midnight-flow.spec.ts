import { test, expect } from '@playwright/test';

test('polling never accepts a pending request or decrypts an unreleased contact', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { createMidnightFlow } = await import(/* @vite-ignore */ '/src/' + 'midnight-flow.ts');
    const calls: string[] = [];
    const record = { id: 'r', conversationId: 'room', status: 'requested', myDecision: 'pending', peerDecision: 'accepted', expiresAt: new Date(Date.now() + 60000).toISOString() };
    const flow = createMidnightFlow({ eventId: 'e', participantId: 'p', ticket: { leaf: null } } as any, {
      request: (async (path: string) => { calls.push(path); return record; }) as any,
      runtime: async () => { throw new Error('CRYPTO_MUST_NOT_RUN'); },
    });
    return { view: await flow.advanceReveal({ id: 'room', status: 'active', revealRequestId: 'r' } as any), calls };
  });
  expect(result.view?.myDecision).toBe('pending');
  expect(result.view?.peerContact).toBeUndefined();
  expect(result.calls).toEqual(['/events/e/reveal-requests/r']);
});

test('ambiguous transaction submission stays blocked across controller recreation', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { createMidnightFlow } = await import(/* @vite-ignore */ '/src/' + 'midnight-flow.ts');
    localStorage.clear();
    let submissions = 0;
    let intents = 0;
    const record = { id: 'r', conversationId: 'room', status: 'awaiting_chain', myDecision: 'accepted', peerDecision: 'accepted', expiresAt: new Date(Date.now() + 60000).toISOString() };
    const deps = {
      request: (async (path: string) => {
        if (path.endsWith('/chain-intents')) { intents++; return { id: 'i', operationId: 'o', mode: 'real', expiresAt: record.expiresAt }; }
        return record;
      }) as any,
      runtime: async () => ({ submitApproval: async () => { submissions++; throw new Error('WALLET_CONNECTION_LOST'); } }) as any,
    };
    const me = { eventId: 'e', participantId: 'p', ticket: { leaf: null } } as any;
    const room = { id: 'room', status: 'active', revealRequestId: 'r' } as any;
    const errors: string[] = [];
    for (let i = 0; i < 2; i++) try { await createMidnightFlow(me, deps).advanceReveal(room); } catch (e) { errors.push((e as Error).message); }
    return { submissions, intents, errors };
  });
  expect(result.submissions).toBe(1);
  expect(result.intents).toBe(1);
  expect(result.errors).toEqual(['WALLET_CONNECTION_LOST', 'TRANSACTION_OUTCOME_UNKNOWN_DO_NOT_RESUBMIT']);
});

test('a room closed while decrypting never publishes the peer contact', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { createMidnightFlow } = await import(/* @vite-ignore */ '/src/' + 'midnight-flow.ts');
    const record = { id: 'r', conversationId: 'room', status: 'released', myDecision: 'accepted', peerDecision: 'accepted' };
    const flow = createMidnightFlow({ eventId: 'e', participantId: 'p', ticket: { leaf: null } } as any, {
      request: (async (path: string) => path.includes('/conversations/') ? { id: 'room', status: 'closed', revealRequestId: 'r' } : record) as any,
      runtime: async () => ({ openPeer: async () => 'secret.peer' }) as any,
    });
    return flow.advanceReveal({ id: 'room', status: 'active', revealRequestId: 'r' } as any);
  });
  expect(result?.peerContact).toBeUndefined();
});

test('recovered submission registers the existing transaction without proving again', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { createMidnightFlow } = await import(/* @vite-ignore */ '/src/' + 'midnight-flow.ts');
    localStorage.clear();
    const record = { id: 'r', conversationId: 'room', status: 'awaiting_chain', myDecision: 'accepted', peerDecision: 'accepted', expiresAt: new Date(Date.now() + 60000).toISOString() };
    localStorage.setItem('zkiss:flow:v1:e:p:reveal:r', JSON.stringify({ key: 'stable', submitting: true, intent: { id: 'i', operationId: 'o', mode: 'real', expiresAt: record.expiresAt } }));
    const sent: unknown[] = [];
    const flow = createMidnightFlow({ eventId: 'e', participantId: 'p', ticket: { leaf: null } } as any, {
      request: (async (path: string, options: any) => {
        if (path.endsWith('/transactions')) { sent.push(options.body); return {}; }
        if (path.includes('/operations/')) return { status: 'succeeded', effectApplied: true };
        if (path.endsWith('/chain-intents')) throw new Error('DUPLICATE_INTENT');
        return record;
      }) as any,
      runtime: async () => ({ recoverSubmission: async () => ({ transactionId: 'original-tx' }), submitApproval: async () => { throw new Error('DUPLICATE_PROOF'); } }) as any,
    });
    const room = { id: 'room', status: 'active', revealRequestId: 'r' } as any;
    await flow.advanceReveal(room);
    await flow.advanceReveal(room);
    return sent;
  });
  expect(result).toEqual([{ transactionId: 'original-tx' }]);
});

test('cancel remains available while proof is running and prevents envelope upload', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { createMidnightFlow } = await import(/* @vite-ignore */ '/src/' + 'midnight-flow.ts');
    localStorage.clear();
    let state = 'awaiting_chain';
    let finish!: () => void;
    let started!: () => void;
    const signal = new Promise<void>(resolve => { started = resolve; });
    const proof = new Promise<void>(resolve => { finish = resolve; });
    const record = () => ({ id: 'r', conversationId: 'room', status: state, myDecision: 'accepted', peerDecision: 'accepted', expiresAt: new Date(Date.now() + 60000).toISOString() });
    const flow = createMidnightFlow({ eventId: 'e', participantId: 'p', ticket: { leaf: null } } as any, {
      request: (async (path: string) => {
        if (path.endsWith('/chain-intents')) return { id: 'i', operationId: 'o', mode: 'real', expiresAt: record().expiresAt };
        if (path.endsWith('/decisions')) { state = 'cancelled'; return record(); }
        if (path.endsWith('/transactions')) return {};
        if (path.includes('/operations/')) return { status: 'succeeded', effectApplied: true };
        if (path.endsWith('/my-envelope')) throw new Error('CANCELLED_ENVELOPE_UPLOADED');
        return record();
      }) as any,
      runtime: async () => ({ submitApproval: async () => { started(); await proof; return { transactionId: 'tx' }; } }) as any,
    });
    const room = { id: 'room', status: 'active', revealRequestId: 'r' } as any;
    const pending = flow.advanceReveal(room);
    await signal;
    const cancelled = await flow.decideReveal(room, 'cancel');
    const polled = await flow.advanceReveal(room);
    finish();
    return { cancelled, polled, completed: await pending };
  });
  expect(result.cancelled.status).toBe('cancelled');
  expect(result.polled?.status).toBe('cancelled');
  expect(result.completed?.status).toBe('cancelled');
});

test('safe pre-upload recovery requires explicit retry before proving again', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { createMidnightFlow } = await import(/* @vite-ignore */ '/src/' + 'midnight-flow.ts');
    localStorage.clear();
    const record = { id: 'r', conversationId: 'room', status: 'awaiting_chain', myDecision: 'accepted', peerDecision: 'accepted', expiresAt: new Date(Date.now() + 60000).toISOString() };
    localStorage.setItem('zkiss:flow:v1:e:p:reveal:r', JSON.stringify({ key: 'stable', submitting: true, intent: { id: 'i', operationId: 'o', mode: 'real', expiresAt: record.expiresAt } }));
    let proofs = 0;
    const flow = createMidnightFlow({ eventId: 'e', participantId: 'p', ticket: { leaf: null } } as any, {
      request: (async (path: string) => path.includes('/operations/') ? { status: 'succeeded', effectApplied: true } : record) as any,
      runtime: async () => ({ recoverSubmission: async () => { throw new Error('SAFE_TO_REPROVE'); }, submitApproval: async () => { proofs++; return {transactionId:'safe-tx'}; } }) as any,
    });
    const room = { id: 'room', status: 'active', revealRequestId: 'r' } as any;
    const errors: string[] = [];
    for (let i = 0; i < 2; i++) try { await flow.advanceReveal(room); } catch (e) { errors.push((e as Error).message); }
    const before = proofs;
    await flow.advanceReveal(room, true);
    return { errors, before, proofs };
  });
  expect(result).toEqual({ errors: ['SAFE_TO_REPROVE', 'SAFE_TO_REPROVE'], before: 0, proofs: 1 });
});
