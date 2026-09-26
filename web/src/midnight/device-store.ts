/** Device-only encrypted storage. Same-origin script access is still trusted;
 * this is not a defense against XSS or a compromised device. No network calls.
 */
type WrappedKey = { version: 1; wrappingKey: CryptoKey; iv: Uint8Array; publicKey: ArrayBuffer; sealed: ArrayBuffer };
const request = <T>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
async function open() {
  const r = indexedDB.open('zkiss-device-v1', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('secrets');
  return request(r);
}
async function read(db: IDBDatabase, scope: string): Promise<WrappedKey | undefined> {
  return request(db.transaction('secrets').objectStore('secrets').get(scope));
}
async function unwrap(record: WrappedKey): Promise<CryptoKeyPair> {
  if (record.version !== 1 || !record.wrappingKey) throw Error('DEVICE_KEY_UNREADABLE');
  const plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: record.iv as Uint8Array<ArrayBuffer> }, record.wrappingKey, record.sealed));
  try {
    return {
      privateKey: await crypto.subtle.importKey('pkcs8', plaintext, { name: 'X25519' }, false, ['deriveBits']),
      publicKey: await crypto.subtle.importKey('raw', record.publicKey, { name: 'X25519' }, true, []),
    };
  } finally { plaintext.fill(0); }
}
/** Scope must include event + participant + purpose/room. Never share across users. */
export async function deviceKey(scope: string, requireExisting = false): Promise<CryptoKeyPair> {
  if (!scope) throw Error('DEVICE_SCOPE_REQUIRED');
  const db = await open();
  try {
    const existing = await read(db, scope);
    if (existing !== undefined) return await unwrap(existing);
    if (requireExisting) throw Error('DEVICE_KEY_LOST');
    const pair = await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']) as CryptoKeyPair;
    const wrappingKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const plaintext = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    let record: WrappedKey;
    try { record = { version: 1, wrappingKey, iv, publicKey: await crypto.subtle.exportKey('raw', pair.publicKey), sealed: await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, wrappingKey, plaintext) }; }
    finally { plaintext.fill(0); }
    // Atomic add: concurrent tabs must converge on the same key, never overwrite.
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('secrets', 'readwrite'); tx.objectStore('secrets').add(record, scope);
        tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); tx.onerror = () => {};
      });
    } catch (error) {
      if (!(error instanceof DOMException) || error.name !== 'ConstraintError') throw error;
    }
    const stored = await read(db, scope);
    if (!stored) throw Error('DEVICE_KEY_NOT_PERSISTED');
    return await unwrap(stored);
  } finally { db.close(); }
}

/** Encrypted structured private state. The non-exportable wrapping key remains
 * in IndexedDB; this protects storage exports, not scripts executing in origin. */
type SealedState = { version: 2; key: CryptoKey; iv: Uint8Array; ciphertext: ArrayBuffer };
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value, (_k, v) => v instanceof Uint8Array ? { $bytes: Array.from(v) } : v));
const decode = (value: ArrayBuffer) => JSON.parse(new TextDecoder().decode(value), (_k, v) => v && Array.isArray(v.$bytes) ? new Uint8Array(v.$bytes) : v);
export async function readSecret<T>(scope: string): Promise<T | null> {
  const db = await open();
  try {
    const r = await request<SealedState | undefined>(db.transaction('secrets').objectStore('secrets').get('state:'+scope));
    if (!r) return null;
    if (r.version !== 2) throw Error('DEVICE_STATE_UNREADABLE');
    const clear = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: r.iv as Uint8Array<ArrayBuffer>, additionalData: new TextEncoder().encode(scope) }, r.key, r.ciphertext);
    try { return decode(clear) as T; } finally { new Uint8Array(clear).fill(0); }
  } finally { db.close(); }
}
export async function writeSecret(scope: string, value: unknown): Promise<void> {
  const db = await open();
  try {
    const key = await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const clear = encode(value);
    let ciphertext: ArrayBuffer;
    try { ciphertext = await crypto.subtle.encrypt({ name:'AES-GCM',iv,additionalData:new TextEncoder().encode(scope)}, key, clear); }
    finally { clear.fill(0); }
    await new Promise<void>((resolve,reject) => {
      const tx = db.transaction('secrets','readwrite'); tx.objectStore('secrets').put({version:2,key,iv,ciphertext},'state:'+scope);
      tx.oncomplete=()=>resolve(); tx.onabort=()=>reject(tx.error); tx.onerror=()=>{};
    });
  } finally { db.close(); }
}
export async function withDeviceLock<T>(scope: string, fn: () => Promise<T>): Promise<T> {
  if (!navigator.locks) throw Error('DEVICE_LOCKS_UNAVAILABLE');
  return navigator.locks.request('zkiss:'+scope,fn);
}
