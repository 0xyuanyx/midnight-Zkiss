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
test('photo-only multipart recovers explicit version from header',async()=>{const r=await upload(undefined,'2');expect(r.statusCode).toBe(200);expect(r.json().expectedVersion).toBe(2);});
test('legacy multipart and matching duplicate metadata remain compatible',async()=>{for(const header of [undefined,'2'])expect((await upload('2',header)).statusCode).toBe(200);});
test('missing, invalid, unsafe and conflicting versions never reach processing',async()=>{for(const [field,header] of [[undefined,undefined],[undefined,'undefined'],[undefined,'9007199254740992'],['1','2']] as const)expect((await upload(field,header)).statusCode).not.toBe(200);});

test('browser API sends the same version in the multipart field and header',async()=>{
  const {Api}=await import('../../web/src/state/api.js');
  const {vi}=await import('vitest');
  const fetcher=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify({data:{id:'job'}})));
  try {
    const form=new FormData();form.append('expectedVersion','2');form.append('photo',new Blob([new Uint8Array(jpeg)],{type:'image/jpeg'}),'photo.jpeg');
    await new Api().request('/events/test/me/ai-jobs','POST',form);
    const options=fetcher.mock.calls[0][1]!;
    expect(options.headers).toMatchObject({'x-profile-version':'2'});
    expect((options.body as FormData).get('expectedVersion')).toBe('2');
  } finally {fetcher.mockRestore();}
});
