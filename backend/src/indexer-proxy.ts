import type { FastifyInstance } from 'fastify';
import { WebSocket, WebSocketServer } from 'ws';
/** Fixed operator-configured upstream only. Indexer contains public chain data. */
export async function registerIndexerProxy(app: FastifyInstance, target: string) {
  const upstream=new URL(target);
  if(!['http:','https:'].includes(upstream.protocol))throw Error('INDEXER_PROXY_URL_INVALID');
  const route='/midnight-indexer/api/v3/graphql';
  app.post(route,{bodyLimit:65536,config:{rateLimit:{max:120,timeWindow:'1 minute',allowList:()=>false}}},async(req,reply)=>{
    const response=await fetch(upstream,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(req.body),signal:AbortSignal.timeout(30000)});
    return reply.code(response.status).type('application/json').send(await response.text());
  });
  const wss=new WebSocketServer({noServer:true,maxPayload:1024*1024});
  app.server.on('upgrade',(req,socket,head)=>{
    let pathname: string;
    try { pathname=new URL(req.url??'','http://localhost').pathname; } catch { socket.destroy(); return; }
    if(pathname!==route+'/ws'){socket.destroy();return;}
    const ip=req.socket.remoteAddress??'unknown';
    if(wss.clients.size>=64 || [...wss.clients].filter(client=>(client as WebSocket & {remoteIp?:string}).remoteIp===ip).length>=8){socket.write('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n');socket.destroy();return;}
    wss.handleUpgrade(req,socket,head,client=>{
      (client as WebSocket & {remoteIp?:string}).remoteIp=ip;
      const wsUrl=new URL(upstream);wsUrl.protocol=wsUrl.protocol==='https:'?'wss:':'ws:';wsUrl.pathname+='/ws';
      const protocols=req.headers['sec-websocket-protocol']?.split(',').map(x=>x.trim());
      const remote=new WebSocket(wsUrl,protocols,{handshakeTimeout:10000,maxPayload:1024*1024});
      const lifetime=setTimeout(()=>{client.close(1000,'Reconnect');remote.close();},30*60*1000);
      lifetime.unref();
      const queued:{data:Buffer;binary:boolean}[]=[];
      client.on('message',(data,binary)=>{
        const bytes=Buffer.from(data as Buffer);
        if(remote.bufferedAmount>1024*1024){client.close(1008,'Backpressure');return;}
        if(remote.readyState===WebSocket.OPEN)remote.send(bytes,{binary});
        else if(queued.reduce((size,item)=>size+item.data.length,0)+bytes.length<=65536)queued.push({data:bytes,binary});
        else client.close(1008,'Queue limit');
      });
      remote.on('open',()=>{for(const item of queued)remote.send(item.data,{binary:item.binary});queued.length=0;});
      remote.on('message',(data,binary)=>{if(client.bufferedAmount>1024*1024){remote.close();client.close(1008,'Backpressure');return;}if(client.readyState===WebSocket.OPEN)client.send(data,{binary});});
      client.on('close',()=>{clearTimeout(lifetime);remote.close();});client.on('error',()=>remote.close());
      remote.on('close',()=>client.close());remote.on('error',()=>client.close(1011,'Indexer unavailable'));
    });
  });
  app.addHook('onClose',async()=>{for(const client of wss.clients)client.terminate();wss.close();});
}
