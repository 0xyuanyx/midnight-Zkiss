import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  decodeContact,
  decodePayload,
  encodeContact,
  encodePayload,
  fromBase64Url,
  isoToSeconds,
  parseBindingHash,
  randomBytes32,
  toBase64Url,
} from '../../src/encoding.js';
import { generateRoomKey, openContact, sealContact } from '../../src/envelope.js';

// Stand-ins for the contract pure circuits; the real ones are exercised in zkiss.contract.test.ts / devnet tests.
const h = (...parts: Uint8Array[]) => {
  const x = createHash('sha256');
  parts.forEach((p) => x.update(p));
  return new Uint8Array(x.digest());
};
const keyCommit = (pk: Uint8Array) => h(new TextEncoder().encode('rk'), pk);
const contactCommit = (c: Uint8Array, s: Uint8Array) => h(new TextEncoder().encode('cc'), c, s);

describe('encoding', () => {
  it('round-trips both payload kinds with fixed lengths', () => {
    const a = { kind: 'admission' as const, bindingHash: randomBytes32(), expiresAt: 1_800_000_000n, eventScope: randomBytes32() };
    const ea = encodePayload(a);
    expect(ea.length).toBe(73);
    expect(decodePayload(fromBase64Url(toBase64Url(ea)))).toEqual(a);
    const r = {
      kind: 'reveal_approval' as const,
      bindingHash: randomBytes32(),
      expiresAt: 1n,
      roomId: randomBytes32(),
      slotIndex: 1 as const,
      transcript: randomBytes32(),
    };
    const er = encodePayload(r);
    expect(er.length).toBe(106);
    expect(decodePayload(er)).toEqual(r);
  });

  it('rejects malformed payloads and binding hashes', () => {
    expect(() => decodePayload(new Uint8Array(72))).toThrow(/PAYLOAD_FORMAT/);
    const bad = encodePayload({ kind: 'reveal_approval', bindingHash: randomBytes32(), expiresAt: 1n, roomId: randomBytes32(), slotIndex: 0, transcript: randomBytes32() });
    bad[73] = 2;
    expect(() => decodePayload(bad)).toThrow(/SLOT_RANGE/);
    expect(() => parseBindingHash('AB'.repeat(32))).toThrow(/BINDING_HASH_FORMAT/);
    expect(() => parseBindingHash('ab'.repeat(31))).toThrow(/BINDING_HASH_FORMAT/);
    expect(parseBindingHash('ab'.repeat(32)).length).toBe(32);
  });

  it('normalizes contacts to NFC and refuses to truncate', () => {
    const decomposed = 'é'; // é as e + combining accent
    expect(decodeContact(encodeContact(decomposed))).toBe('é');
    expect(() => encodeContact('x'.repeat(65))).toThrow(/CONTACT_TOO_LONG/);
    expect(() => encodeContact('')).toThrow(/CONTACT_EMPTY/);
    expect(decodeContact(encodeContact('x'.repeat(64)))).toBe('x'.repeat(64));
  });

  it('parses whole-second ISO timestamps only', () => {
    expect(isoToSeconds('2026-09-25T00:00:00Z')).toBe(1_790_294_400n);
    expect(() => isoToSeconds('2026-09-25T00:00:00.5Z')).toThrow(/TIME_PRECISION/);
    expect(() => isoToSeconds('nope')).toThrow(/TIME_INVALID/);
  });
});

describe('envelope (RFC 9180 HPKE base mode)', () => {
  const setup = async () => {
    const b = await generateRoomKey();
    const transcript = randomBytes32();
    const contact = encodeContact('alice.insta');
    const salt = randomBytes32();
    const env = await sealContact({
      recipientPub: b.publicKey,
      recipientKeyCommit: keyCommit(b.publicKey),
      recipientKeyVersion: 1,
      transcript,
      contact,
      contactSalt: salt,
      keyCommit,
    });
    const open = (over: Partial<Parameters<typeof openContact>[0]> = {}) =>
      openContact({
        recipientKey: b,
        recipientKeyCommit: keyCommit(b.publicKey),
        transcript,
        envelope: env,
        expectedContactCommit: contactCommit(contact, salt),
        contactCommit,
        ...over,
      });
    return { b, transcript, contact, salt, env, open };
  };

  it('matches the backend wire shape and opens only for the intended recipient', async () => {
    const { open, env, transcript } = await setup();
    expect(env.suite).toBe('hpke-x25519-hkdfsha256-aes128gcm-v1');
    expect(Buffer.from(env.enc, 'base64').length).toBe(32);
    expect(env.ciphertext).toMatch(/^[A-Za-z0-9+/]*={0,2}$/); // standard base64 (backend validates this)
    expect(Buffer.from(env.ciphertext, 'base64').length).toBe(96 + 16);
    expect(env.contextHash).toBe(Buffer.from(transcript).toString('hex'));
    const r = await open();
    expect(r.ok).toBe(true);
    if (r.ok) expect(decodeContact(r.contact)).toBe('alice.insta');
  });

  it('two seals of the same contact differ (fresh HPKE encapsulation each time)', async () => {
    const { b, transcript, contact, salt } = await setup();
    const seal = () => sealContact({ recipientPub: b.publicKey, recipientKeyCommit: keyCommit(b.publicKey), recipientKeyVersion: 1, transcript, contact, contactSalt: salt, keyCommit });
    const [x, y] = [await seal(), await seal()];
    expect(x.enc).not.toBe(y.enc);
    expect(x.ciphertext).not.toBe(y.ciphertext);
  });

  it('refuses to seal to a public key that does not open the approved recipient commitment (review H2)', async () => {
    const { b } = await setup();
    const server = await generateRoomKey();
    await expect(
      sealContact({ recipientPub: server.publicKey, recipientKeyCommit: keyCommit(b.publicKey), recipientKeyVersion: 1, transcript: randomBytes32(), contact: encodeContact('x'), contactSalt: randomBytes32(), keyCommit }),
    ).rejects.toThrow(/RECIPIENT_KEY_MISMATCH/);
  });

  it('fails closed on wrong context, wrong key, changed contact commitment, tampering or bad format', async () => {
    const { open, env } = await setup();
    const eve = await generateRoomKey();
    expect(await open({ transcript: randomBytes32() })).toEqual({ ok: false, reasonCode: 'CONTEXT_MISMATCH' });
    expect(await open({ envelope: { ...env, contextHash: Buffer.from(randomBytes32()).toString('hex') } })).toEqual({ ok: false, reasonCode: 'CONTEXT_MISMATCH' });
    expect(await open({ recipientKey: eve })).toEqual({ ok: false, reasonCode: 'DECRYPT_FAILED' });
    expect(await open({ recipientKeyCommit: randomBytes32() })).toEqual({ ok: false, reasonCode: 'DECRYPT_FAILED' }); // AAD binds my key commit
    expect(await open({ expectedContactCommit: randomBytes32() })).toEqual({ ok: false, reasonCode: 'CONTACT_COMMIT_MISMATCH' });
    const ct = Buffer.from(env.ciphertext, 'base64');
    ct[10] ^= 1;
    expect(await open({ envelope: { ...env, ciphertext: ct.toString('base64') } })).toEqual({ ok: false, reasonCode: 'DECRYPT_FAILED' });
    expect(await open({ envelope: { ...env, enc: Buffer.alloc(31).toString('base64') } })).toEqual({ ok: false, reasonCode: 'ENVELOPE_FORMAT' });
    expect(await open({ envelope: { ...env, suite: 'other' as any } })).toEqual({ ok: false, reasonCode: 'ENVELOPE_FORMAT' });
  });
});
