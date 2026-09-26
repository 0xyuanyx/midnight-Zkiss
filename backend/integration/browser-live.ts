/** Isolated, opt-in real Local Devnet browser harness. No participant witnesses
 * are generated here. Synthetic AI only; actual admission/reveal ZK runs in UI.
 * Start with MIDNIGHT_SOURCE_DIR=/absolute/path/midnight node --experimental-import-meta-resolve --import tsx ...
 */
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { database } from '../test/helpers.js';
import { migrate } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { localConfig } from '../src/config.js';
import { loadProviders } from '../src/providers.js';
import { processChainJobs,reconcile } from '../src/worker.js';
if(!process.env.MIDNIGHT_SOURCE_DIR)throw Error('MIDNIGHT_SOURCE_DIR_REQUIRED');
const source=resolve(process.env.MIDNIGHT_SOURCE_DIR);
const moduleAt=(p:string)=>import(pathToFileURL(resolve(source,p)).href);
const {setNetworkId}=await import(import.meta.resolve('@midnight-ntwrk/midnight-js/network-id',pathToFileURL(resolve(source,'package.json')).href));
const {buildWallet,configureProviders,localConfig:endpoints}=await moduleAt('src/node/wallet.ts');
const {createOperatorRuntime,ZK_PATH}=await moduleAt('src/node/operator.ts');
const {createRelay}=await moduleAt('src/node/relay.ts');
const {randomBytes32}=await moduleAt('src/encoding.ts');
setNetworkId('undeployed');
console.log('BROWSER_LIVE syncing Local Devnet fee wallet');
const wallet=await buildWallet(endpoints,process.env.BROWSER_LIVE_WALLET_SEED??'0'.repeat(63)+'1');
const providers=await configureProviders(wallet,endpoints,ZK_PATH,'browser-live-'+randomUUID());
// Operator and relay share one serialized fee-provider queue in this harness.
let tail:Promise<unknown>=Promise.resolve();
const originalBalance=providers.walletProvider.balanceTx.bind(providers.walletProvider);
providers.walletProvider.balanceTx=(...args:any[])=>{
  const run=tail.then(()=>originalBalance(...args),()=>originalBalance(...args));tail=run.catch(()=>{});return run;
};
const operator=createOperatorRuntime({network:'undeployed',endpoints,operatorSecret:randomBytes32(),providers});
const end=new Date(Date.now()+6*3600000);
console.log('BROWSER_LIVE deploying isolated event');
const event=await operator.deployEvent(end);
Object.assign(process.env,{MIDNIGHT_NETWORK:'undeployed',MIDNIGHT_INDEXER_URL:endpoints.indexer,MIDNIGHT_CAPABILITIES:'admission,reveal',MIDNIGHT_CONTRACT_ALLOWLIST:event.contractAddress});
const port=Number(process.env.BROWSER_LIVE_PORT??3119);
const origin=process.env.BROWSER_LIVE_ORIGIN??'http://localhost:5190';
const config={...localConfig,mode:'real' as const,secureCookies:true,origin,sessionRateLimit:1000,midnightAdapterModule:resolve(source,'src/node/adapter.module.ts')};
const {midnight}=await loadProviders(config);if(!midnight)throw Error('ADAPTER_UNAVAILABLE');
const relay=createRelay({network:'undeployed',endpoints,providers,indexerUrl:'/midnight-indexer/api/v3/graphql',indexerWsUrl:'/midnight-indexer/api/v3/graphql/ws'});
const db=await database();await migrate(db.pool);
const eventId=process.env.BROWSER_LIVE_EVENT_ID??'evt_browser_live';
await db.pool.query(`INSERT INTO events(id,name,join_until,discover_until,chat_until,modes,sns_reveal,midnight_network,midnight_contract_address,midnight_event_scope) VALUES($1,'Browser real proof test',$2,$2,$2,'["mutual_like"]',true,$3,$4,$5)`,[eventId,end,event.network,event.contractAddress,event.eventScope]);
const app=await buildApp({pool:db.pool,config,midnight,relay,ai:{mode:'real',async analyze(){return {intro:'[Synthetic AI fixture] Browser proof integration.',modelVersion:'browser-live-fixture'};}}});
await app.listen({host:'127.0.0.1',port});
let running=false;
const timer=setInterval(async()=>{if(running)return;running=true;try{await processChainJobs(db.pool,midnight,operator.operator);await reconcile(db.pool,midnight);}catch(error){console.error('BROWSER_LIVE worker',error instanceof Error?error.message:'ERROR');}finally{running=false;}},1500);
console.log('BROWSER_LIVE_READY '+JSON.stringify({eventId,api:`http://127.0.0.1:${port}`,origin,contractAddress:event.contractAddress,eventScope:event.eventScope}));
console.log(`VITE_EVENT_ID=${eventId} ZKISS_API_TARGET=http://127.0.0.1:${port} npm run dev -w web -- --host localhost --port 5190`);
await new Promise<void>(resolve=>{process.once('SIGINT',resolve);process.once('SIGTERM',resolve);});
clearInterval(timer);await app.close();await operator.stop();await relay.stop();await wallet.wallet.stop();await db.close();
