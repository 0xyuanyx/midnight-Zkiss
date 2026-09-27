import { ApiError, type Api, type Reveal } from './api';
/** Material/terms updates may race a click. Retry only the same disclosure request. */
export async function decideReveal(api: Api, initial: Reveal, action: 'accept' | 'reject' | 'cancel') {
  let current=initial;
  for(let attempt=0;attempt<3;attempt++) {
    try {
      await api.event(`/reveal-requests/${initial.id}/decisions`,'POST',{expectedVersion:current.version,transcriptHash:current.transcriptHash,action});
      return;
    } catch(e) {
      if(!(e instanceof ApiError) || e.code!=='VERSION_CONFLICT' || attempt===2)throw e;
      current=await api.event<Reveal>(`/reveal-requests/${initial.id}`);
      if(['cancelled','rejected','expired','released'].includes(current.status))return;
      if(action==='accept' && current.myDecision==='accepted')return;
    }
  }
}
