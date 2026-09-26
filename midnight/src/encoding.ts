// Canonical byte encodings for zkiss-midnight-v1 (PROTOCOL.md §4–§5).
// No JSON.stringify-based hashing: every public value has a fixed-width layout.

export const PROTOCOL_VERSION = 'zkiss-midnight-v1';
export const CONTACT_BYTES = 64;

export type Bytes32 = Uint8Array;

export const hexToBytes = (hex: string, len?: number): Uint8Array => {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (!/^([0-9a-fA-F]{2})*$/.test(h)) throw new EncodingError('HEX_INVALID', 'not an even-length hex string');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  if (len !== undefined && out.length !== len) throw new EncodingError('HEX_LENGTH', `expected ${len} bytes, got ${out.length}`);
  return out;
};

export const bytesToHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

// btoa/atob keep this module usable in both browsers and Node without Buffer.
export const toBase64Url = (b: Uint8Array): string =>
  btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export const fromBase64Url = (s: string): Uint8Array => {
  if (!/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) throw new EncodingError('B64_INVALID', 'not base64url');
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

export class EncodingError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`);
  }
}

/** Backend bindingHash = SHA-256 of binding-v1 bytes, hex. Used as-is; never re-hashed here. */
export const parseBindingHash = (bindingHash: string): Bytes32 => {
  if (!/^[0-9a-f]{64}$/.test(bindingHash)) throw new EncodingError('BINDING_HASH_FORMAT', 'expected 64 lowercase hex chars');
  return hexToBytes(bindingHash, 32);
};

/** ISO-8601 → whole seconds (the unit compared by blockTimeLt). Rejects sub-second / invalid input. */
export const isoToSeconds = (iso: string): bigint => {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) throw new EncodingError('TIME_INVALID', `invalid timestamp ${iso}`);
  if (ms % 1000 !== 0) throw new EncodingError('TIME_PRECISION', 'expiresAt must be whole seconds');
  if (ms <= 0) throw new EncodingError('TIME_RANGE', 'expiresAt must be positive');
  return BigInt(ms / 1000);
};

/** SNS handle → NFC-normalized UTF-8, zero-padded to 64 bytes. Longer input is rejected, never truncated. */
export const encodeContact = (contact: string): Uint8Array => {
  const raw = new TextEncoder().encode(contact.normalize('NFC'));
  if (raw.length === 0) throw new EncodingError('CONTACT_EMPTY', 'contact is empty');
  if (raw.length > CONTACT_BYTES) throw new EncodingError('CONTACT_TOO_LONG', `contact exceeds ${CONTACT_BYTES} bytes`);
  if (raw.includes(0)) throw new EncodingError('CONTACT_NUL', 'contact contains NUL');
  const out = new Uint8Array(CONTACT_BYTES);
  out.set(raw);
  return out;
};

export const decodeContact = (bytes: Uint8Array): string => {
  if (bytes.length !== CONTACT_BYTES) throw new EncodingError('CONTACT_LENGTH', 'bad contact length');
  let end = bytes.indexOf(0);
  if (end === -1) end = CONTACT_BYTES;
  if (bytes.subarray(end).some((x) => x !== 0)) throw new EncodingError('CONTACT_PADDING', 'non-zero padding');
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, end));
};

// ---- publicPayload (PROTOCOL.md §5) ----

export type AdmissionPayload = {
  kind: 'admission';
  bindingHash: Bytes32;
  expiresAt: bigint;
  eventScope: Bytes32;
};

export type RevealPayload = {
  kind: 'reveal_approval';
  bindingHash: Bytes32;
  expiresAt: bigint;
  roomId: Bytes32;
  slotIndex: 0 | 1;
  transcript: Bytes32;
};

export type PublicPayload = AdmissionPayload | RevealPayload;

const u64 = (v: bigint): Uint8Array => {
  if (v < 0n || v >= 1n << 64n) throw new EncodingError('U64_RANGE', 'value out of u64 range');
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, v, false);
  return b;
};

const need32 = (b: Uint8Array, name: string) => {
  if (b.length !== 32) throw new EncodingError('FIELD_LENGTH', `${name} must be 32 bytes`);
  return b;
};

export const encodePayload = (p: PublicPayload): Uint8Array => {
  if (p.kind === 'admission') {
    return concat([Uint8Array.of(0x01), need32(p.bindingHash, 'bindingHash'), u64(p.expiresAt), need32(p.eventScope, 'eventScope')]);
  }
  if (p.slotIndex !== 0 && p.slotIndex !== 1) throw new EncodingError('SLOT_RANGE', 'slotIndex must be 0 or 1');
  return concat([
    Uint8Array.of(0x02),
    need32(p.bindingHash, 'bindingHash'),
    u64(p.expiresAt),
    need32(p.roomId, 'roomId'),
    Uint8Array.of(p.slotIndex),
    need32(p.transcript, 'transcript'),
  ]);
};

export const decodePayload = (b: Uint8Array): PublicPayload => {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b[0] === 0x01 && b.length === 1 + 32 + 8 + 32) {
    return { kind: 'admission', bindingHash: b.slice(1, 33), expiresAt: dv.getBigUint64(33, false), eventScope: b.slice(41, 73) };
  }
  if (b[0] === 0x02 && b.length === 1 + 32 + 8 + 32 + 1 + 32) {
    const slot = b[73];
    if (slot !== 0 && slot !== 1) throw new EncodingError('SLOT_RANGE', 'slotIndex must be 0 or 1');
    return {
      kind: 'reveal_approval',
      bindingHash: b.slice(1, 33),
      expiresAt: dv.getBigUint64(33, false),
      roomId: b.slice(41, 73),
      slotIndex: slot,
      transcript: b.slice(74, 106),
    };
  }
  throw new EncodingError('PAYLOAD_FORMAT', 'unknown payload tag or length');
};

export const concat = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

export const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

export const randomBytes32 = (): Bytes32 => crypto.getRandomValues(new Uint8Array(32));

// ---- RevealTerms wire format (adapter.revealTerms → backend → device) ----
// requestNonce(32) | expiresAtSec(u64) | keyCommitA(32) | keyCommitB(32) | contactCommitA(32) | contactCommitB(32) | policyVersion(u32)
// Same field set and order as the contract's RevealTerms struct.

export type TermsFields = {
  requestNonce: Uint8Array;
  expiresAt: bigint;
  keyCommitA: Uint8Array;
  keyCommitB: Uint8Array;
  contactCommitA: Uint8Array;
  contactCommitB: Uint8Array;
  policyVersion: bigint;
};

const TERMS_BYTES = 32 + 8 + 32 * 4 + 4;

export const encodeTerms = (t: TermsFields): Uint8Array => {
  if (t.policyVersion < 0n || t.policyVersion >= 1n << 32n) throw new EncodingError('U32_RANGE', 'policyVersion out of u32 range');
  const pv = new Uint8Array(4);
  new DataView(pv.buffer).setUint32(0, Number(t.policyVersion), false);
  return concat([
    need32(t.requestNonce, 'requestNonce'),
    u64(t.expiresAt),
    need32(t.keyCommitA, 'keyCommitA'),
    need32(t.keyCommitB, 'keyCommitB'),
    need32(t.contactCommitA, 'contactCommitA'),
    need32(t.contactCommitB, 'contactCommitB'),
    pv,
  ]);
};

export const decodeTerms = (b: Uint8Array): TermsFields => {
  if (b.length !== TERMS_BYTES) throw new EncodingError('TERMS_FORMAT', `expected ${TERMS_BYTES} bytes`);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return {
    requestNonce: b.slice(0, 32),
    expiresAt: dv.getBigUint64(32, false),
    keyCommitA: b.slice(40, 72),
    keyCommitB: b.slice(72, 104),
    contactCommitA: b.slice(104, 136),
    contactCommitB: b.slice(136, 168),
    policyVersion: BigInt(dv.getUint32(168, false)),
  };
};
