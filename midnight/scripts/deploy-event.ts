// 행사 계약 배포 CLI: npx tsx scripts/deploy-event.ts --event-end 2026-10-01T23:00:00Z
// 출력(JSON)의 network/contractAddress/eventScope를 백엔드 events 테이블에 저장한다. 비밀은 출력하지 않는다.
import { createOperatorRuntime } from '../src/node/operator.js';
import { readEndpoints, readNetwork, readOperatorSecrets } from '../src/node/env.js';

const arg = process.argv.indexOf('--event-end');
if (arg === -1 || !process.argv[arg + 1]) {
  console.error('usage: tsx scripts/deploy-event.ts --event-end <ISO time>');
  process.exit(2);
}
const eventEnd = new Date(process.argv[arg + 1]);
if (Number.isNaN(eventEnd.getTime()) || eventEnd.getTime() <= Date.now()) {
  console.error('event end must be a future ISO time');
  process.exit(2);
}
const rt = createOperatorRuntime({ network: readNetwork(), endpoints: readEndpoints(), ...readOperatorSecrets() });
try {
  const r = await rt.deployEvent(eventEnd);
  console.log(JSON.stringify({ ...r, eventEnd: eventEnd.toISOString(), operatorKey: rt.operatorKey() }, null, 2));
} finally {
  await rt.stop();
}
process.exit(0);
