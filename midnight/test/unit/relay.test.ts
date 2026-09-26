import { afterEach, expect, it, vi } from 'vitest';
import { Transaction } from '@midnight-ntwrk/ledger-v8';
const outcome = vi.hoisted(() => vi.fn());
vi.mock('../../src/ledger-decoder.js', () => ({ zkissIndexerView: () => ({ txOutcome: outcome }) }));
afterEach(() => { vi.restoreAllMocks(); outcome.mockReset(); });
import { createRelay } from '../../src/node/relay.js';
import type { VerificationInput } from '../../src/adapter-contract.js';
it('classifies only pre-spend validation errors as safe to retry', async () => {
  const balanceTx = vi.fn();
  const relay = createRelay({ network: 'undeployed', endpoints: {} as any, providers: { walletProvider: { balanceTx } } as any });
  const event = { network: 'undeployed', contractAddress: 'ab'.repeat(32), eventScope: 'cd'.repeat(32) };
  const input = { network: 'other', contractAddress: event.contractAddress } as VerificationInput;
  await expect(relay.validate('AAAA', input, event)).rejects.toThrow('RELAY_SCOPE_MISMATCH');
  await expect(relay.balance('AAAA', input, event)).rejects.toMatchObject({ message: 'RELAY_VALIDATION_FAILED', safeToRetry: true });
  expect(balanceTx).not.toHaveBeenCalled();
});

it.each(['success', 'partial', 'failure'])('recovers finalized exact-transaction retry with indexed %s outcome', async status => {
  vi.spyOn(Transaction, 'deserialize').mockReturnValue({ identifiers: () => ['aa', 'bb'] } as any);
  outcome.mockResolvedValue(status);
  const relay = createRelay({ network: 'undeployed', endpoints: { indexer: 'http://unused' } as any, providers: { midnightProvider: { submitTx: async () => { throw Error('AlreadyImported'); } } } as any });
  await expect(relay.submit('AAAA')).resolves.toBe('bb');
  expect(outcome).toHaveBeenCalledWith('bb');
});
it('does not claim submission when indexer outcome is unknown', async () => {
  vi.spyOn(Transaction, 'deserialize').mockReturnValue({ identifiers: () => ['bb'] } as any);
  outcome.mockResolvedValue('unknown');
  const relay = createRelay({ network: 'undeployed', endpoints: { indexer: 'http://unused' } as any, providers: { midnightProvider: { submitTx: async () => { throw Error('SubmissionUnknown'); } } } as any });
  await expect(relay.submit('AAAA')).rejects.toThrow('SubmissionUnknown');
});
