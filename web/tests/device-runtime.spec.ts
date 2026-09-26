import {test,expect} from '@playwright/test';
const config={network:'undeployed',contractAddress:'a'.repeat(64),eventScope:'b'.repeat(64),coinPublicKey:'c'.repeat(64),encryptionPublicKey:'d'.repeat(64),indexerUrl:'/midnight-indexer/api/v3/graphql',indexerWsUrl:'/midnight-indexer/api/v3/graphql/ws'};
test('real cryptographic device state survives reload without plaintext IndexedDB',async({page})=>{
  await page.route('**/api/v1/events/device-test/midnight/relay',route=>route.fulfill({json:{data:config}}));
  await page.goto('/');
  const first=await page.evaluate(async()=>{
    const path='/src/midnight/'+'runtime.ts';const {createBrowserRuntime}=await import(path);
    const runtime=await createBrowserRuntime({eventId:'device-test',participantId:'alice'});
    const ticket=await runtime.ticket();const vault=await runtime.saveContact('synthetic.private');
    const material=await runtime.roomMaterial({chainRoomId:'e'.repeat(64)});
    const stored=await new Promise<unknown[]>((resolve,reject)=>{const r=indexedDB.open('zkiss-device-v1');r.onerror=()=>reject(r.error);r.onsuccess=()=>{const db=r.result;const get=db.transaction('secrets').objectStore('secrets').getAll();get.onsuccess=()=>{resolve(get.result);db.close();};};});
    return {ticket,vault,material,plaintextPresent:JSON.stringify(stored).includes('synthetic.private')};
  });
  expect(first.plaintextPresent).toBe(false);
  expect(first.vault.ownerEnvelope.suite).toBe('hpke-x25519-hkdfsha256-aes128gcm-v1');
  await page.reload();
  const second=await page.evaluate(async(ticketLeaf)=>{
    const path='/src/midnight/'+'runtime.ts';const {createBrowserRuntime}=await import(path);
    const runtime=await createBrowserRuntime({eventId:'device-test',participantId:'alice',ticketLeaf});
    return {ticket:await runtime.ticket(),contact:await runtime.getContact(),material:await runtime.roomMaterial({chainRoomId:'e'.repeat(64)})};
  },first.ticket.ticketLeaf);
  expect(second.ticket).toEqual(first.ticket);expect(second.material).toEqual(first.material);expect(second.contact).toBe('synthetic.private');
  const lost=await page.evaluate(async()=>{const path='/src/midnight/'+'runtime.ts';const {createBrowserRuntime}=await import(path);try{await createBrowserRuntime({eventId:'device-test',participantId:'missing',ticketLeaf:'f'.repeat(64)});return 'unexpected';}catch(e){return (e as Error).message;}});
  expect(lost).toBe('DEVICE_STATE_LOST');
});
test('stale SDK private state cannot erase newer rooms or replace secrets',async({page})=>{
  await page.goto('/');
  const result=await page.evaluate(async()=>{
    const path='/src/midnight/'+'state-merge.ts';const {mergePrivateState}=await import(path);
    const secret=(n:number)=>({recipientPk:new Uint8Array([n]),contact:new Uint8Array([n]),contactSalt:new Uint8Array([n])});
    const current={ticketSecret:new Uint8Array([1]),roomSecrets:{old:secret(1),new:secret(2)}};
    const stale={ticketSecret:new Uint8Array([1]),roomSecrets:{old:secret(1)}};
    const rooms=Object.keys(mergePrivateState(current,stale).roomSecrets);
    const rejects=(value:unknown)=>{try{mergePrivateState(current,value);return false;}catch{return true;}};
    return {rooms,conflict:rejects({...stale,roomSecrets:{old:secret(3)}}),ticket:rejects({...stale,ticketSecret:new Uint8Array([2])}),operator:rejects({...stale,operatorSecret:new Uint8Array([1])})};
  });
  expect(result).toEqual({rooms:['old','new'],conflict:true,ticket:true,operator:true});
});
test('SDK participant signing key persists encrypted and rejects contract changes',async({page})=>{
  await page.goto('/');
  const result=await page.evaluate(async()=>{
    const path='/src/midnight/'+'sdk-signing-store.ts';const {sdkSigningStore}=await import(path);
    const address='a'.repeat(64),key='b'.repeat(64);const store=sdkSigningStore('sdk-test',address);
    await store.setSigningKey(address,key);
    let wrongContract=false,changedKey=false;
    try{await store.getSigningKey('c'.repeat(64));}catch{wrongContract=true;}
    try{await store.setSigningKey(address,'d'.repeat(64));}catch{changedKey=true;}
    return {key:await sdkSigningStore('sdk-test',address).getSigningKey(address),wrongContract,changedKey};
  });
  expect(result).toEqual({key:'b'.repeat(64),wrongContract:true,changedKey:true});
  await page.reload();
  expect(await page.evaluate(async()=>{const path='/src/midnight/'+'sdk-signing-store.ts';const {sdkSigningStore}=await import(path);return sdkSigningStore('sdk-test','a'.repeat(64)).getSigningKey('a'.repeat(64));})).toBe('b'.repeat(64));
});
