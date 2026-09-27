import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import sharp from 'sharp';
import { test, expect } from 'vitest';
import { readUpload } from '../src/upload.js';
const jpeg = await sharp({create:{width:588,height:420,channels:3,background:'#abcdef'}}).jpeg().toBuffer();
async function upload(field?:string, header?:string) {
  const app = Fastify();
  await app.register(multipart);
  app.post('/',async req=>{const cleanup=await readUpload(req);try{return req.body;}finally{cleanup();}});
  const boundary='----WebKitFormBoundaryUploadTest';
  const payload=Buffer.concat([Buffer.from((field === undefined ? '' : `--${boundary}\r\nContent-Disposition: form-data; name="expectedVersion"\r\n\r\n${field}\r\n`)+`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="photo.jpeg"\r\nContent-Type: image/jpeg\r\n\r\n`),jpeg,Buffer.from(`\r\n--${boundary}--\r\n`)]);
  try { return await app.inject({method:'POST',url:'/',headers:{'content-type':`multipart/form-data; boundary=${boundary}`,...(header===undefined?{}:{'x-profile-version':header})},payload}); } finally {await app.close();}
}
test('a version header cannot substitute for missing multipart content',async()=>{expect((await upload(undefined,'2')).statusCode).not.toBe(200);});
test('existing multipart upload remains compatible',async()=>{expect((await upload('2')).statusCode).toBe(200);});
test('missing, invalid and unsafe versions never reach processing',async()=>{for(const version of [undefined,'undefined','9007199254740992'])expect((await upload(version)).statusCode).not.toBe(200);});

test('explicit byte serialization arrives with the exact photo bytes and version',async()=>{
  const {Api}=await import('../../web/src/state/api.js');
  const {snapshotPhoto}=await import('../../web/src/state/photo-upload.js');
  const {hash}=await import('../src/http.js');
  const {vi}=await import('vitest');
  const app=Fastify();await app.register(multipart);
  app.post('/',async req=>{const cleanup=await readUpload(req);try{return {data:req.body};}finally{cleanup();}});
  const fetcher=vi.spyOn(globalThis,'fetch').mockImplementation(async(_url,options)=>{
    expect(options!.body).toBeInstanceOf(Uint8Array);
    const r=await app.inject({method:'POST',url:'/',headers:options!.headers as Record<string,string>,payload:Buffer.from(options!.body as Uint8Array)});
    return new Response(r.body,{status:r.statusCode});
  });
  try {
    for(const format of ['jpeg','png','webp'] as const){
      const bytes=await sharp(jpeg)[format]().toBuffer();
      const original=new File([new Uint8Array(bytes)],'한글 사진.'+format,{type:'image/'+format});
      const snapshot=await snapshotPhoto(original);
      // The selected disk file is no longer consulted after the route unmounts.
      Object.defineProperty(original,'arrayBuffer',{value:()=>Promise.reject(new Error('revoked file handle'))});
      const form=new FormData();form.append('expectedVersion','2');form.append('photo',snapshot);
      const result=await new Api().request<{photoHash:string;expectedVersion:number}>('/','POST',form);
      expect(result).toEqual({photoHash:hash(bytes),expectedVersion:2});
    }
  }finally{fetcher.mockRestore();await app.close();}
});
test('unreadable or incomplete disk files fail before being marked ready',async()=>{
  const {snapshotPhoto}=await import('../../web/src/state/photo-upload.js');
  for(const read of [()=>Promise.reject(new Error('unavailable')),()=>Promise.resolve(new ArrayBuffer(0))]){
    const file=new File([new Uint8Array(jpeg)],'photo.jpeg',{type:'image/jpeg'});
    Object.defineProperty(file,'arrayBuffer',{value:read});
    await expect(snapshotPhoto(file)).rejects.toThrow('PHOTO_READ_FAILED');
  }
});
