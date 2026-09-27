// MIDNIGHT_OPERATOR_MODULE 진입점(worker 전용). default export = MidnightOperator.
// 필요한 환경: MIDNIGHT_OPERATOR_WALLET_SEED, MIDNIGHT_OPERATOR_SECRET(32바이트 hex), MIDNIGHT_NETWORK, 노드·인덱서·증명 서버 URL.
// 지갑 동기화는 첫 호출 때 시작한다(수 초~수십 초).
import { createOperatorRuntime } from './operator.js';
import { readEndpoints, readNetwork, readOperatorSecrets } from '../src/node/env.js';

const runtime = createOperatorRuntime({
  network: readNetwork(),
  endpoints: readEndpoints(),
  ...readOperatorSecrets(),
  privateStateStore: process.env.MIDNIGHT_OPERATOR_STATE_STORE,
});

export default runtime.operator;
