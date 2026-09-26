import { ApiError } from '../state/api';
let worker: Worker | undefined;
let idle: ReturnType<typeof setTimeout> | undefined;
let warming: Promise<void> | undefined;
let active: { resolve: (s: string) => void; reject: (e: Error) => void } | undefined;
let warmResolve: (()=>void) | undefined, warmReject: ((e:Error)=>void)|undefined;
const retire = () => {clearTimeout(idle);worker?.terminate();worker=undefined;warming=undefined;};
const scheduleIdle = () => {clearTimeout(idle);idle=setTimeout(()=>{if(!active)retire();},120000);};
function getWorker() {
  if(worker)return worker;
  worker=new Worker(new URL('./proof.worker.ts',import.meta.url),{type:'module'});
  worker.onmessage=({data})=>{
    if(data.metric){console.info('SNS_TIMING',data.metric,Math.round(data.durationMs));return;}
    if(data.stage){console.info('SNS_PROOF_STAGE',data.stage);return;}
    if(data.warmed){warmResolve?.();warmResolve=undefined;warmReject=undefined;scheduleIdle();return;}
    if(data.error){
      const e=new ApiError(data.error==='PROOF_ASSET_UNAVAILABLE'?data.error:'PROOF_FAILED');
      warmReject?.(e);active?.reject(e);active=undefined;retire();return;
    }
    if(data.transaction){active?.resolve(data.transaction);active=undefined;scheduleIdle();}
  };
  worker.onerror=()=>{const e=new ApiError('PROOF_FAILED');warmReject?.(e);active?.reject(e);active=undefined;retire();};
  return worker;
}
export function warmProof(): Promise<void> {
  if(active)return Promise.resolve();
  scheduleIdle();
  return warming ??= new Promise<void>((resolve,reject)=>{
    const timer=setTimeout(()=>{retire();reject(new ApiError('PROOF_ASSET_UNAVAILABLE'));},120000);
    warmResolve=()=>{clearTimeout(timer);resolve();};warmReject=e=>{clearTimeout(timer);reject(e);};getWorker().postMessage({type:'warm'});
  }).catch(e=>{warming=undefined;throw e;});
}
let lane: Promise<unknown>=Promise.resolve();
export function prove(data: unknown): Promise<string> {
  const job=lane.catch(()=>{}).then(async()=>{
    await warmProof();clearTimeout(idle);
    return new Promise<string>((resolve,reject)=>{
      const timer=setTimeout(()=>{active=undefined;retire();reject(new ApiError('PROOF_TIMEOUT'));},8*60000);
      active={resolve:s=>{clearTimeout(timer);resolve(s);},reject:e=>{clearTimeout(timer);reject(e);}};
      getWorker().postMessage(data);
    });
  });
  lane=job;return job;
}
