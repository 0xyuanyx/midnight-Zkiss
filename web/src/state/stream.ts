/** One authenticated stream per session; EventSource retains Last-Event-ID on reconnect. */
export function watchSession(eventId: string, changed: () => void, connected: (value: boolean) => void) {
  const source=new EventSource(`/api/v1/events/${encodeURIComponent(eventId)}/stream`);
  let timer: ReturnType<typeof setTimeout>|undefined;
  source.onopen=()=>{connected(true);changed();};
  source.onerror=()=>connected(false);
  const refresh=()=>{if(timer)return;timer=setTimeout(()=>{timer=undefined;changed();},80);};
  for(const kind of ['reveal.status_changed','conversation.preparation_changed','operation.updated','conversation.created','conversation.closed','message.created','like.received','like.status_changed','answer.received','answer.status_changed']) source.addEventListener(kind,refresh);
  return ()=>{clearTimeout(timer);source.close();connected(false);};
}
