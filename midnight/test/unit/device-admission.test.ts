import { expect, it, vi } from 'vitest';
import { admissionNullifierFor, newParticipant, submitAdmission } from '../../src/device.js';
import { encodePayload, randomBytes32, toBase64Url, PROTOCOL_VERSION } from '../../src/encoding.js';
it('device rejects a payload bound to another ticket before submitting', async () => {
  const privateState = newParticipant(), other = newParticipant(), eventScope = randomBytes32();
  const admit = vi.fn(async () => ({ public: { txId: 'tx' } }));
  const handle = { callTx: { admit, approveReveal: admit, leaveRoom: admit } };
  const payload = { kind: 'admission' as const, bindingHash: randomBytes32(), expiresAt: 1800000000n, eventScope, admissionNullifier: admissionNullifierFor(other, eventScope) };
  const intent = { protocolVersion: PROTOCOL_VERSION, network: 'undeployed', contractAddress: 'ab'.repeat(32), circuit: 'admit', publicPayload: toBase64Url(encodePayload(payload)), zkManifestUrl: null };
  const ctx = { ...intent, eventScope, privateState };
  await expect(submitAdmission(handle, intent, ctx)).rejects.toThrow('ADMISSION_NULLIFIER_MISMATCH');
  expect(admit).not.toHaveBeenCalled();
  intent.publicPayload = toBase64Url(encodePayload({ ...payload, admissionNullifier: admissionNullifierFor(privateState, eventScope) }));
  await expect(submitAdmission(handle, intent, ctx)).resolves.toEqual({ transactionId: 'tx', txHash: null });
});
