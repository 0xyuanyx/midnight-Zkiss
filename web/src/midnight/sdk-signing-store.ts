import {readSecret,writeSecret,withDeviceLock} from './device-store';
/** findDeployedContract creates a local signing key even for participant calls.
 * It is not the deployed contract's maintenance authority or operator witness.
 * Keep it encrypted and scoped; the sponsor only accepts participant circuits. */
export function sdkSigningStore(scope:string,contractAddress:string) {
  const key=scope+':sdk-signing:'+contractAddress.toLowerCase();
  const check=(address:string)=>{if(address.toLowerCase()!==contractAddress.toLowerCase())throw Error('CONTRACT_MISMATCH');};
  return {
    async getSigningKey(address:string){check(address);return readSecret<string>(key);},
    async setSigningKey(address:string,signingKey:string){
      check(address);if(!signingKey)throw Error('SDK_SIGNING_KEY_INVALID');
      await withDeviceLock(key,async()=>{
        const stored=await readSecret<string>(key);
        if(stored&&stored!==signingKey)throw Error('SDK_SIGNING_KEY_CHANGED');
        if(!stored)await writeSecret(key,signingKey);
      });
    },
    async removeSigningKey(address:string){check(address);throw Error('DEVICE_STATE_REMOVAL_DISABLED');},
    async clearSigningKeys(){throw Error('DEVICE_STATE_REMOVAL_DISABLED');},
  };
}
