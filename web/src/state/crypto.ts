import { Aes128Gcm, CipherSuite, HkdfSha256 } from '@hpke/core';
import { DhkemX25519HkdfSha256 } from '@hpke/dhkem-x25519';
import { ApiError } from './api';
const suite = new CipherSuite({ kem: new DhkemX25519HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes128Gcm() });
const encode = (value: string) => new TextEncoder().encode(value);
const b64 = (value: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(value)));
const bytes = (value: string) => Uint8Array.from(atob(value), c => c.charCodeAt(0)).buffer;
export const randomHex = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), n => n.toString(16).padStart(2, '0')).join('');
export const digest = async (text: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encode(text))), n => n.toString(16).padStart(2, '0')).join('');
export interface Envelope { suite: 'hpke-x25519-hkdfsha256-aes128gcm-v1'; enc: string; ciphertext: string; contextHash: string; recipientKeyVersion: number }
export interface LocalIdentity { publicKey: string; privateKey: string; salt: string; contact?: Envelope; commitment?: string }
// Tab-scoped: no SNS plaintext or private key is sent to the backend.
export async function identity(id: string, create = false): Promise<LocalIdentity> {
  const stored = sessionStorage.getItem(`zkiss.identity.v1:${id}`);
  if (stored) return JSON.parse(stored);
  if (!create) throw new ApiError('KEYS_MISSING');
  const pair = await suite.kem.generateKeyPair();
  const value = { publicKey: b64(await suite.kem.serializePublicKey(pair.publicKey)), privateKey: b64(await suite.kem.serializePrivateKey(pair.privateKey)), salt: randomHex() };
  saveIdentity(id, value); return value;
}
export function saveIdentity(id: string, value: LocalIdentity) { sessionStorage.setItem(`zkiss.identity.v1:${id}`, JSON.stringify(value)); }
export async function encrypt(text: string, publicKey: string, contextHash: string, version = 1): Promise<Envelope> {
  const sender = await suite.createSenderContext({ recipientPublicKey: await suite.kem.deserializePublicKey(bytes(publicKey)), info: encode(contextHash) });
  return { suite: 'hpke-x25519-hkdfsha256-aes128gcm-v1', enc: b64(sender.enc), ciphertext: b64(await sender.seal(encode(text), encode(contextHash))), contextHash, recipientKeyVersion: version };
}
export async function decrypt(envelope: Envelope, key: LocalIdentity, contextHash: string) {
  if (envelope.contextHash !== contextHash || envelope.suite !== 'hpke-x25519-hkdfsha256-aes128gcm-v1') throw new Error('Invalid envelope context');
  const recipient = await suite.createRecipientContext({ recipientKey: await suite.kem.deserializePrivateKey(bytes(key.privateKey)), enc: bytes(envelope.enc), info: encode(contextHash) });
  return new TextDecoder().decode(await recipient.open(bytes(envelope.ciphertext), encode(contextHash)));
}
