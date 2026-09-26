// Off-chain SNS envelope (PROTOCOL.md §6), RFC 9180 HPKE base mode:
// DHKEM(X25519, HKDF-SHA256) / HKDF-SHA256 / AES-128-GCM via @hpke/core (hpke-js), WebCrypto only.
// Wire shape matches the backend's `hpke-x25519-hkdfsha256-aes128gcm-v1` envelope.
// Chain approval does not imply delivery: the recipient must still open the envelope and check the contact commitment.
import { Aes128Gcm, CipherSuite, DhkemX25519HkdfSha256, HkdfSha256 } from '@hpke/core';
import { CONTACT_BYTES, EncodingError, bytesEqual, bytesToHex, concat, hexToBytes } from './encoding.js';

export const ENVELOPE_SUITE = 'hpke-x25519-hkdfsha256-aes128gcm-v1' as const;
const INFO = new TextEncoder().encode('zkiss:v1:envelope');
const PLAIN_BYTES = CONTACT_BYTES + 32; // contact ‖ commit salt

const suite = new CipherSuite({ kem: new DhkemX25519HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes128Gcm() });

/** Backend envelope wire format (standard base64, not base64url). */
export type Envelope = {
  suite: typeof ENVELOPE_SUITE;
  enc: string; // 32-byte HPKE encapsulated key
  ciphertext: string;
  contextHash: string; // transcriptHash (hex)
  recipientKeyVersion: number;
};

export type RoomKeyPair = { publicKey: Uint8Array; keyPair: CryptoKeyPair };

const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Fresh per-room X25519 key. Never reuse the profile/session key: that would link an anonymous room to a profile. */
export const generateRoomKey = async (): Promise<RoomKeyPair> => {
  const keyPair = await suite.kem.generateKeyPair();
  return { publicKey: new Uint8Array(await suite.kem.serializePublicKey(keyPair.publicKey)), keyPair };
};

const aad = (transcript: Uint8Array, recipientKeyCommit: Uint8Array) => concat([transcript, recipientKeyCommit]);

export type SealInput = {
  recipientPub: Uint8Array;
  recipientKeyCommit: Uint8Array; // the counterpart's commit in the terms I approved
  recipientKeyVersion: number;
  transcript: Uint8Array;
  contact: Uint8Array; // encodeContact() output
  contactSalt: Uint8Array;
  /** recipientKeyCommit pure circuit. A server-supplied key that does not open the approved commit is refused (review H2). */
  keyCommit: (pk: Uint8Array) => Uint8Array;
};

export const sealContact = async (i: SealInput): Promise<Envelope> => {
  if (i.contact.length !== CONTACT_BYTES || i.contactSalt.length !== 32) throw new EncodingError('ENVELOPE_INPUT', 'bad contact/salt length');
  if (!bytesEqual(i.keyCommit(i.recipientPub), i.recipientKeyCommit)) {
    throw new EncodingError('RECIPIENT_KEY_MISMATCH', 'recipient key does not open the approved commitment');
  }
  const { ct, enc } = await suite.seal(
    { recipientPublicKey: await suite.kem.deserializePublicKey(i.recipientPub), info: INFO },
    concat([i.contact, i.contactSalt]),
    aad(i.transcript, i.recipientKeyCommit),
  );
  return {
    suite: ENVELOPE_SUITE,
    enc: b64(new Uint8Array(enc)),
    ciphertext: b64(new Uint8Array(ct)),
    contextHash: bytesToHex(i.transcript),
    recipientKeyVersion: i.recipientKeyVersion,
  };
};

export type OpenInput = {
  recipientKey: RoomKeyPair;
  recipientKeyCommit: Uint8Array; // my own commit in the approved terms
  transcript: Uint8Array;
  envelope: Envelope;
  /** Sender's contact commitment fixed by the finalized transcript. */
  expectedContactCommit: Uint8Array;
  contactCommit: (contact: Uint8Array, salt: Uint8Array) => Uint8Array;
};

export type OpenResult =
  | { ok: true; contact: Uint8Array }
  | { ok: false; reasonCode: 'ENVELOPE_FORMAT' | 'CONTEXT_MISMATCH' | 'DECRYPT_FAILED' | 'CONTACT_COMMIT_MISMATCH' };

/**
 * Only an `ok: true` result may drive S20; anything else maps to the N06 failure state.
 * Base mode does not authenticate the sender key; integrity of the revealed contact comes from the contact
 * commitment in the approved transcript, whose salt only the sender knows.
 */
export const openContact = async (i: OpenInput): Promise<OpenResult> => {
  const e = i.envelope;
  let enc: Uint8Array, ct: Uint8Array;
  try {
    if (e.suite !== ENVELOPE_SUITE) return { ok: false, reasonCode: 'ENVELOPE_FORMAT' };
    enc = unb64(e.enc);
    ct = unb64(e.ciphertext);
  } catch {
    return { ok: false, reasonCode: 'ENVELOPE_FORMAT' };
  }
  if (enc.length !== 32 || ct.length !== PLAIN_BYTES + 16) return { ok: false, reasonCode: 'ENVELOPE_FORMAT' };
  if (!/^[0-9a-f]{64}$/.test(e.contextHash) || !bytesEqual(hexToBytes(e.contextHash), i.transcript)) {
    return { ok: false, reasonCode: 'CONTEXT_MISMATCH' };
  }
  let plain: Uint8Array;
  try {
    plain = new Uint8Array(
      await suite.open({ recipientKey: i.recipientKey.keyPair, enc, info: INFO }, ct, aad(i.transcript, i.recipientKeyCommit)),
    );
  } catch {
    return { ok: false, reasonCode: 'DECRYPT_FAILED' };
  }
  const contact = plain.slice(0, CONTACT_BYTES);
  const salt = plain.slice(CONTACT_BYTES);
  if (!bytesEqual(i.contactCommit(contact, salt), i.expectedContactCommit)) return { ok: false, reasonCode: 'CONTACT_COMMIT_MISMATCH' };
  return { ok: true, contact };
};
