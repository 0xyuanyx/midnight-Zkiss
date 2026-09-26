import type { ZkissPrivateState } from '../../../midnight/contract/witnesses.js';
const equal=(a:Uint8Array,b:Uint8Array)=>a.length===b.length&&a.every((v,i)=>v===b[i]);
/** SDK execution may finish after another room was created. Validate the old
 * snapshot and add its rooms without dropping newer persisted room secrets. */
export function mergePrivateState(current:ZkissPrivateState,incoming:ZkissPrivateState):ZkissPrivateState {
  if(!equal(current.ticketSecret,incoming.ticketSecret)||incoming.operatorSecret)throw Error('PRIVATE_STATE_SCOPE_MISMATCH');
  const roomSecrets={...current.roomSecrets};
  for(const [roomId,secret]of Object.entries(incoming.roomSecrets)) {
    const old=roomSecrets[roomId];
    if(old&&(!equal(old.recipientPk,secret.recipientPk)||!equal(old.contact,secret.contact)||!equal(old.contactSalt,secret.contactSalt)))throw Error('ROOM_SECRET_CONFLICT');
    roomSecrets[roomId]=secret;
  }
  return {...current,roomSecrets};
}
