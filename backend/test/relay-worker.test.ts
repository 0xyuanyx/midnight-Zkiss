import { test, expect } from 'vitest';
import { processRelayJobs } from '../src/relay-worker.js';
import type { MidnightOperator } from '../src/adapters/midnight.js';

test('relay persists balanced bytes before broadcast and reuses them after ambiguous failure', async () => {
  const calls: string[] = [];
  const job: any = { intent_id:'intent',prepared:{},expires_at:new Date(Date.now()+60000),reveal_request_id:'reveal',operation_status:'awaiting_submission',proven_transaction:'proven' };
  const pool: any = {
    connect: async () => ({query:async(sql:string)=>({rows:[{locked:true}]}),release() {}}),
    async query(sql:string,args:any[]) {
      if(sql.startsWith('SELECT j.')) return {rows:[{...job}]};
      if(sql.startsWith('SELECT status')) return {rows:[{status:'awaiting_chain'}]};
      if(sql.includes('balanced_transaction=$2')) {calls.push('persist');job.balanced_transaction=args[1];job.transaction_id=args[2];}
      return {rows:[]};
    },
  };
  let attempts=0;
  const unused = async (): Promise<never> => { throw new Error("unexpected operator call"); };
  const operator: MidnightOperator={
    mode:"real", issueTicket:unused, openRoom:unused, closeRoom:unused, isTicketIssued:unused, roomState:unused,
    async prepareRelay(){calls.push('prepare');return {transaction:'same-balanced-bytes',transactionId:'tx'};},
    async submitRelay(raw:string){calls.push('submit');expect(raw).toBe('same-balanced-bytes');if(attempts++===0)throw Error('timeout');},
  };
  await processRelayJobs(pool,operator);
  await processRelayJobs(pool,operator);
  expect(calls).toEqual(['prepare','persist','submit','submit']);
});
