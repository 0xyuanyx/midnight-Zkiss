import { it, expect } from 'vitest';
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { WebSocket, WebSocketServer } from 'ws';
import { registerIndexerProxy } from '../src/indexer-proxy.js';
it('proxies public indexer queries and subscriptions to the fixed upstream', async()=>{
  const upstream=Fastify();upstream.post('/api/v3/graphql',async req=>({data:{query:(req.body as any).query}}));
  const sockets=new WebSocketServer({server:upstream.server,path:'/api/v3/graphql/ws'});
  sockets.on('connection',client=>client.on('message',data=>client.send(data.toString())));
  const target=await upstream.listen({host:'127.0.0.1',port:0});
  const app=Fastify();await app.register(rateLimit,{allowList:()=>true});await registerIndexerProxy(app,target+'/api/v3/graphql');
  const origin=await app.listen({host:'127.0.0.1',port:0});
  try{
    const response=await app.inject({method:'POST',url:'/midnight-indexer/api/v3/graphql',payload:{query:'query { block { height } }'}});
    expect(response.json().data.query).toContain('block');
    for(let n=0;n<119;n++)expect((await app.inject({method:'POST',url:'/midnight-indexer/api/v3/graphql',payload:{query:'query { block { height } }'}})).statusCode).toBe(200);
    expect((await app.inject({method:'POST',url:'/midnight-indexer/api/v3/graphql',payload:{query:'query { block { height } }'}})).statusCode).toBe(429);
    const socket=new WebSocket(origin.replace('http:','ws:')+'/midnight-indexer/api/v3/graphql/ws','graphql-transport-ws');
    await new Promise<void>((resolve,reject)=>{socket.on('open',()=>socket.send('subscription'));socket.on('message',data=>{expect(data.toString()).toBe('subscription');socket.close();resolve();});socket.on('error',reject);});
  }finally{await app.close();for(const s of sockets.clients)s.terminate();sockets.close();await upstream.close();}
});
