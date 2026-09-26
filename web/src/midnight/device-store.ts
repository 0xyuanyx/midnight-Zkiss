/** Encrypted device-only storage. Wrap X25519 keys because WebKit cannot
 * reliably structured-clone them to IndexedDB. No network or server storage. */
interface Wrapped { version: 2; wrappingKey: CryptoKey; iv: Uint8Array<ArrayBuffer>; sealed: ArrayBuffer; progress: Record<string, unknown> }
const database = new Promise<IDBDatabase>((resolve,reject)=>{
  const request=indexedDB.open('zkiss-sns-v1',1);
  request.onupgradeneeded=()=>request.result.createObjectStore('rooms');
  request.onsuccess=()=>resolve(request.result); request.onerror=()=>reject(request.error);
});
const get = async (key: string): Promise<any> => {
  const db=await database;
  return new Promise((resolve,reject)=>{const r=db.transaction('rooms').objectStore('rooms').get(key);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
};
const put = async (key: string,value: Wrapped) => {
  const db=await database;
  await new Promise<void>((resolve,reject)=>{const t=db.transaction('rooms','readwrite');t.objectStore('rooms').put(value,key);t.oncomplete=()=>resolve();t.onabort=()=>reject(t.error);t.onerror=()=>{};});
  if (!(await get(key))) throw new Error('DEVICE_KEY_NOT_PERSISTED');
};
export async function readDevice<T>(key:string):Promise<T|undefined> {
  const record=await get(key); if(!record)return undefined;
  if(record.version!==2)return record as T; // earlier local Chromium records
  const plain=new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:record.iv},record.wrappingKey,record.sealed));
  try {
    const decoded=JSON.parse(new TextDecoder().decode(plain),(_key,v)=>v && typeof v==='object' && Array.isArray(v.u8)?new Uint8Array(v.u8):v);
    const keyPair={
      publicKey:await crypto.subtle.importKey('raw',decoded.setup.roomKey.publicKey,{name:'X25519'},true,[]),
      privateKey:await crypto.subtle.importKey('pkcs8',decoded.pkcs8,{name:'X25519'},false,['deriveBits']),
    };
    decoded.pkcs8.fill(0);delete decoded.pkcs8;
    decoded.setup.roomKey.keyPair=keyPair;
    return {...decoded,...record.progress} as T;
  } finally {plain.fill(0);}
}
export async function writeDevice(key:string,value:any) {
  let record=await get(key) as Wrapped|undefined;
  if(record?.version!==2) {
    const pkcs8=new Uint8Array(await crypto.subtle.exportKey('pkcs8',value.setup.roomKey.keyPair.privateKey));
    const wrappingKey=await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);
    const iv=crypto.getRandomValues(new Uint8Array(12));
    const payload={privateState:value.privateState,setup:{keyCommit:value.setup.keyCommit,contactCommit:value.setup.contactCommit,roomKey:{publicKey:value.setup.roomKey.publicKey}},pkcs8};
    const plaintext=new TextEncoder().encode(JSON.stringify(payload,(_k,v)=>v instanceof Uint8Array?{u8:Array.from(v)}:v));
    try {record={version:2,wrappingKey,iv,sealed:await crypto.subtle.encrypt({name:'AES-GCM',iv},wrappingKey,plaintext),progress:{}};}
    finally {plaintext.fill(0);pkcs8.fill(0);}
  }
  record.progress={intent:value.intent,transaction:value.transaction,submitted:value.submitted};
  await put(key,record);
}
