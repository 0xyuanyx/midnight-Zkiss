import { CipherSuite, Aes128Gcm, DhkemX25519HkdfSha256, HkdfSha256 } from '@hpke/core';
import { serializeRoomPrivateKey, sealContact, openContact } from '../../midnight/src/envelope';
import { setupRoom, newParticipant } from '../../midnight/sns/device';
import { pureCircuits } from '../../midnight/sns/managed/sns/contract/index.js';
import { readDevice, writeDevice } from '../src/midnight/device-store';

export async function probe(legacy: boolean) {
  const roomId = new Uint8Array(32).fill(7);
  const [privateState, setup] = await setupRoom(newParticipant(), roomId, '@compat');
  const key = `compat-${crypto.randomUUID()}`;
  if (legacy) {
    const native = await crypto.subtle.generateKey({name:'X25519'}, true, ['deriveBits']) as CryptoKeyPair;
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', native.privateKey));
    const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', native.publicKey));
    setup.roomKey = { publicKey, keyPair: native };
    setup.keyCommit = pureCircuits.recipientKeyCommit(publicKey);
    const wrappingKey = await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);
    const iv=crypto.getRandomValues(new Uint8Array(12));
    const payload={privateState,setup:{...setup,roomKey:{publicKey}},pkcs8};
    const encoded=new TextEncoder().encode(JSON.stringify(payload,(_k,v)=>v instanceof Uint8Array?{u8:Array.from(v)}:v));
    const sealed=await crypto.subtle.encrypt({name:'AES-GCM',iv},wrappingKey,encoded);
    const db=await new Promise<IDBDatabase>((resolve,reject)=>{const r=indexedDB.open('zkiss-sns-v1',1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
    await new Promise<void>((resolve,reject)=>{const t=db.transaction('rooms','readwrite');t.objectStore('rooms').put({version:2,wrappingKey,iv,sealed,progress:{}},key);t.oncomplete=()=>resolve();t.onerror=()=>reject(t.error);});
    db.close();
  }
  for (const method of ['generateKey','importKey','deriveBits'] as const) {
    const original=(crypto.subtle[method] as Function).bind(crypto.subtle);
    Object.defineProperty(crypto.subtle, method, {configurable:true,value:(...args: any[])=>{
      const alg=args[method==='importKey'?2:0];
      if ((typeof alg==='string'?alg:alg?.name)==='X25519') return Promise.reject(new DOMException('Unsupported X25519','NotSupportedError'));
      return original(...args);
    }});
  }
  let nativeRejected=false;
  try { await new CipherSuite({kem:new DhkemX25519HkdfSha256(),kdf:new HkdfSha256(),aead:new Aes128Gcm()}).kem.generateKeyPair(); }
  catch {nativeRejected=true;}
  if (!legacy) {
    // Exercise key creation after native support is disabled, not only restoration.
    const fresh=await setupRoom(newParticipant(),roomId,'@compat');
    await writeDevice(key,{privateState:fresh[0],setup:fresh[1]});
  }
  const restored=await readDevice<any>(key);
  const before=Array.from(new Uint8Array(await serializeRoomPrivateKey(restored.setup.roomKey.keyPair.privateKey)));
  await writeDevice(key,{...restored,submitted:true});
  const again=await readDevice<any>(key);
  const after=Array.from(new Uint8Array(await serializeRoomPrivateKey(again.setup.roomKey.keyPair.privateKey)));
  const contact=Object.values(again.privateState.roomSecrets)[0] as any;
  const transcript=new Uint8Array(32).fill(9);
  const envelope=await sealContact({recipientPub:again.setup.roomKey.publicKey,recipientKeyCommit:again.setup.keyCommit,recipientKeyVersion:1,transcript,contact:contact.contact,contactSalt:contact.contactSalt,keyCommit:pureCircuits.recipientKeyCommit});
  const opened=await openContact({recipientKey:again.setup.roomKey,recipientKeyCommit:again.setup.keyCommit,transcript,envelope,expectedContactCommit:again.setup.contactCommit,contactCommit:pureCircuits.contactCommit});
  return {nativeRejected,opened:opened.ok,stable:JSON.stringify(before)===JSON.stringify(after),submitted:again.submitted};
}
