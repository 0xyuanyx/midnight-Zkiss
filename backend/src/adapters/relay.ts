import type { EventChain, VerificationInput } from './midnight.js';
/** Receives only proven public transactions; never participant witnesses. */
export interface MidnightRelay {
  mode: 'real';
  info(event: EventChain): Promise<{coinPublicKey:string; encryptionPublicKey:string; indexerUrl:string; indexerWsUrl:string}>;
  validate?(transaction: string, input: VerificationInput, event: EventChain): Promise<void>;
  balance(transaction: string, input: VerificationInput, event: EventChain): Promise<string>;
  submit(transaction: string): Promise<string>;
  stop?(): Promise<void>;
}
