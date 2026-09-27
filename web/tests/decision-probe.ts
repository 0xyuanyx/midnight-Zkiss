import {decideReveal} from '../src/state/reveal-decision';
import {ApiError,type Api,type Reveal} from '../src/state/api';
export async function probe(){
 const calls:unknown[]=[];let failed=false;
 const api={event:async(path:string,method='GET',body?:unknown)=>{
  calls.push({path,method,body});if(method==='POST' && !failed){failed=true;throw new ApiError('VERSION_CONFLICT');}
  return {id:'same',status:'requested',myDecision:'pending',version:4,transcriptHash:'current'};
 }} as unknown as Api;
 await decideReveal(api,{id:'same',status:'collecting',version:3,transcriptHash:null} as Reveal,'reject');
 return calls;
}
