/** Encrypted device-only storage. Wrap X25519 keys because WebKit cannot
 * reliably structured-clone them to IndexedDB. No network or server storage. */
import { serializeRoomPrivateKey, restoreRoomKey } from '../../../midnight/src/envelope';
interface Wrapped { version: 2 | 3; wrappingKey: CryptoKey; iv: Uint8Array<ArrayBuffer>; sealed: ArrayBuffer; progress: Record<string, unknown> }
const database = new Promise<IDBDatabase>((resolve,reject)=>{
  const request=indexedDB.open('zkiss-sns-v1',1);
  request.onupgradeneeded=()=>request.result.createObjectStore('rooms');
  request.onsuccess=()=>resolve(request.result); request.onerror=()=>reject(request.error);
});
const get = async (key: string): Promise<any> => {
  const db=await database;
  return new Promise((resolve,reject)=>{const r=db.transaction('rooms').objectStore('rooms').get(key);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
};
const put = async (key: string,value: Wrapped, create = false) => {
  const db=await database;
  await new Promise<void>((resolve,reject)=>{const t=db.transaction('rooms','readwrite');const store=t.objectStore('rooms');if(create){const r=store.get(key);r.onsuccess=()=>{if(!r.result)store.add(value,key);};}else store.put(value,key);t.oncomplete=()=>resolve();t.onabort=()=>reject(t.error);t.onerror=()=>{};});
  if (!(await get(key))) throw new Error('DEVICE_KEY_NOT_PERSISTED');
};
export async function readDevice<T>(key:string):Promise<T|undefined> {
  const record=await get(key); if(!record)return undefined;
  if(record.version!==2 && record.version!==3)return record as T; // earlier local Chromium records
  const plain=new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:record.iv},record.wrappingKey,record.sealed));
  try {
    const decoded=JSON.parse(new TextDecoder().decode(plain),(_key,v)=>v && typeof v==='object' && Array.isArray(v.u8)?new Uint8Array(v.u8):v);
    let secret = decoded.privateKey as Uint8Array;
    if (record.version === 2) {
      // Existing WebCrypto PKCS#8 X25519 keys: RFC 8410, fixed OID + 32-byte seed.
      const prefix = new Uint8Array([0x30,0x2e,0x02,0x01,0x00,0x30,0x05,0x06,0x03,0x2b,0x65,0x6e,0x04,0x22,0x04,0x20]);
      if (decoded.pkcs8?.length !== 48 || !prefix.every((n, i) => decoded.pkcs8[i] === n)) throw new Error('DEVICE_KEY_FORMAT_INVALID');
      secret = decoded.pkcs8.slice(16);
    }
    const keyPair = await restoreRoomKey(decoded.setup.roomKey.publicKey, secret);
    secret.fill(0); decoded.pkcs8?.fill(0); delete decoded.pkcs8; delete decoded.privateKey;
    decoded.setup.roomKey.keyPair=keyPair;
    return {...decoded,...record.progress} as T;
  } finally {plain.fill(0);}
}
export async function writeDevice(key:string,value:any) {
  let record=await get(key) as Wrapped|undefined;
  const create=record?.version!==2 && record?.version!==3;
  if(create) {
    const privateKey=new Uint8Array(await serializeRoomPrivateKey(value.setup.roomKey.keyPair.privateKey));
    const wrappingKey=await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);
    const iv=crypto.getRandomValues(new Uint8Array(12));
    const payload={privateState:value.privateState,setup:{keyCommit:value.setup.keyCommit,contactCommit:value.setup.contactCommit,roomKey:{publicKey:value.setup.roomKey.publicKey}},privateKey};
    const plaintext=new TextEncoder().encode(JSON.stringify(payload,(_k,v)=>v instanceof Uint8Array?{u8:Array.from(v)}:v));
    try {record={version:3,wrappingKey,iv,sealed:await crypto.subtle.encrypt({name:'AES-GCM',iv},wrappingKey,plaintext),progress:{}};}
    finally {plaintext.fill(0);privateKey.fill(0);}
  }
  record!.progress={intent:value.intent,transaction:value.transaction,submitted:value.submitted};
  await put(key,record!,create);
}

/** Atomic insert chooses one device secret even when tabs initialize concurrently. */
export async function participantSecret(uid: string): Promise<Uint8Array> {
  const key = `device:${uid}`;
  const restore = async (record: any) => new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:record.iv},record.wrappingKey,record.sealed));
  const saved = await get(key); if(saved) return restore(saved);
  const db=await database;
  const keys=await new Promise<IDBValidKey[]>((resolve,reject)=>{const r=db.transaction('rooms').objectStore('rooms').getAllKeys();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
  let secret: Uint8Array<ArrayBuffer>|undefined;
  for(const oldKey of keys) if(typeof oldKey==='string' && oldKey.startsWith(`${uid}:`)) {
    const value=await readDevice<any>(oldKey);
    if(value?.privateState?.participantSecret) {secret=new Uint8Array(value.privateState.participantSecret);break;}
  }
  const legacy=sessionStorage.getItem(`zkiss.sns-device.v1:${uid}`);
  secret ??= legacy ? Uint8Array.from(atob(legacy), c=>c.charCodeAt(0)) : crypto.getRandomValues(new Uint8Array(32));
  const wrappingKey=await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const sealed=await crypto.subtle.encrypt({name:'AES-GCM',iv},wrappingKey,secret);
  secret.fill(0);
  const candidate={version:4,wrappingKey,iv,sealed};
  const winner=await new Promise<any>((resolve,reject)=>{
    const t=db.transaction('rooms','readwrite'), store=t.objectStore('rooms');let selected:any;
    const r=store.get(key);r.onsuccess=()=>{selected=r.result??candidate;if(!r.result)store.add(candidate,key);};
    t.oncomplete=()=>resolve(selected);t.onabort=()=>reject(t.error);
  });
  sessionStorage.removeItem(`zkiss.sns-device.v1:${uid}`);
  return restore(winner);
}
