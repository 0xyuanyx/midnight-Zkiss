import * as ledgerApi from '@midnight-ntwrk/ledger-v8';
import { validateRelay } from './relay.js';
// SNS 전용 운영자: 계약 배포, 대화방 등록·종료 및 승인 거래 대납.
// 사용자 승인 증명은 브라우저에서 생성한다. 운영자는 참가권을 발급하지 않는다.
import path from 'node:path';
import { setNetworkId } from '@midnight-ntwrk/midnight-js/network-id';
import { deployContract, findDeployedContract } from '@midnight-ntwrk/midnight-js/contracts';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { Contract, ledger, pureCircuits } from './managed/sns/contract/index.js';
import { witnesses, type ZkissPrivateState } from './witnesses.js';
import type { EventChain, MidnightOperator } from '../src/adapter-contract.js';
import { bytesToHex, hexToBytes, isoToSeconds, randomBytes32 } from '../src/encoding.js';
import { buildWallet, configureProviders, type Config, type WalletContext } from '../src/node/wallet.js';

export const ZK_PATH = path.resolve(import.meta.dirname, './managed/sns');

export const compiledZkiss = CompiledContract.make('zkiss', Contract).pipe(
  CompiledContract.withWitnesses(witnesses as any),
  CompiledContract.withCompiledFileAssets(ZK_PATH),
);

type Providers = Awaited<ReturnType<typeof configureProviders>>;

export type OperatorOptions = {
  network: string;
  endpoints: Config;
  walletSeed?: string; // 수수료 지갑 seed(hex). 비밀 저장소에서 주입. providers를 주입하면 생략
  /** 테스트용: 이미 동기화된 provider를 재사용한다(같은 seed의 지갑을 두 번 띄우면 코인 선택이 충돌한다). */
  providers?: Providers;
  operatorSecret: Uint8Array; // H(operatorSecret)가 계약의 operator 값. 비밀 저장소에서 주입
  privateStateStore?: string;
};


/** 운영자 지갑 하나로 거래를 동시에 만들면 코인 선택이 충돌한다. 모든 호출을 한 줄로 세운다. */
const serial = () => {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(f: () => Promise<T>): Promise<T> => {
    const run = tail.then(f, f);
    tail = run.catch(() => undefined);
    return run;
  };
};

export const createOperatorRuntime = (o: OperatorOptions) => {
  let ready: Promise<{ wallet: WalletContext | null; providers: Providers }> | null = null;
  const handles = new Map<string, Promise<any>>();
  const queue = serial();
  const privateState = (): ZkissPrivateState => ({ operatorSecret: o.operatorSecret, participantSecret: randomBytes32(), roomSecrets: {} });

  const init = () =>
    (ready ??= (async () => {
      setNetworkId(o.network);
      if (o.providers) return { wallet: null, providers: o.providers };
      if (!o.walletSeed) throw new Error('MISSING_ENV: MIDNIGHT_OPERATOR_WALLET_SEED');
      const wallet = await buildWallet(o.endpoints, o.walletSeed);
      const providers = await configureProviders(wallet, o.endpoints, ZK_PATH, o.privateStateStore ?? 'zkiss-operator');
      return { wallet, providers };
    })());

  const handle = async (e: EventChain) => {
    if (e.network !== o.network) throw new Error(`NETWORK_MISMATCH: ${e.network}`);
    const addr = e.contractAddress.toLowerCase();
    if (!handles.has(addr)) {
      handles.set(
        addr,
        init().then(({ providers }) =>
          findDeployedContract(providers as any, {
            contractAddress: addr,
            compiledContract: compiledZkiss,
            privateStateId: `operator-${addr}`,
            initialPrivateState: privateState(),
          } as any),
        ),
      );
    }
    return handles.get(addr)!;
  };

  const state = async (e: EventChain) => {
    const { providers } = await init();
    const s = await providers.publicDataProvider.queryContractState(e.contractAddress.toLowerCase());
    if (!s) throw new Error('CONTRACT_STATE_UNAVAILABLE');
    const l = ledger(s.data);
    if (bytesToHex(l.eventScope) !== e.eventScope.toLowerCase()) throw new Error('EVENT_SCOPE_MISMATCH');
    return l;
  };

  const txId = (r: any) => ({ transactionId: String(r.public.txId) });

  const operator: MidnightOperator = {
    mode: 'real',
    issueTicket: async () => { throw new Error('ADMISSION_DISABLED'); },
    openRoom: (e, r) =>
      queue(async () =>
        txId(
          await (await handle(e)).callTx.openRoom(hexToBytes(r.roomId, 32), hexToBytes(r.slotA, 32), hexToBytes(r.slotB, 32), isoToSeconds(r.expiresAt)),
        ),
      ),
    closeRoom: (e, roomId) => queue(async () => txId(await (await handle(e)).callTx.closeRoom(hexToBytes(roomId, 32)))),
    isTicketIssued: async () => false,
    roomState: async (e, roomId) => {
      const l = await state(e);
      const k = hexToBytes(roomId, 32);
      if (!l.rooms.member(k)) return 'absent';
      return l.rooms.lookup(k).open ? 'open' : 'closed';
    },
  };

  /** 행사 계약 배포(운영 CLI). eventScope는 행사마다 새 난수. 반환값을 events 테이블에 저장한다. */
  const deployEvent = (eventEnd: Date): Promise<EventChain & { transactionId: string }> =>
    queue(async () => {
      const { providers } = await init();
      const eventScope = randomBytes32();
      const deployed: any = await deployContract(providers as any, {
        compiledContract: compiledZkiss,
        privateStateId: `operator-deploy-${bytesToHex(eventScope).slice(0, 16)}`,
        initialPrivateState: privateState(),
        args: [eventScope, BigInt(Math.floor(eventEnd.getTime() / 1000))],
      } as any);
      return {
        network: o.network,
        contractAddress: String(deployed.deployTxData.public.contractAddress),
        eventScope: bytesToHex(eventScope),
        transactionId: String(deployed.deployTxData.public.txId),
      };
    });

  const operatorKey = () => bytesToHex(pureCircuits.operatorKey(o.operatorSecret));
  const stop = async () => {
    if (ready) await (await ready).wallet?.wallet.stop();
  };

  Object.assign(operator, {
    prepareRelay: (raw: string, prepared: import('../src/adapter-contract.js').PreparedIntent) => queue(async () => {
      if (prepared.network !== o.network) throw new Error('NETWORK_MISMATCH');
      const { providers } = await init();
      const state = await providers.publicDataProvider.queryContractState(prepared.contractAddress);
      if (!state) throw new Error('CHAIN_UNAVAILABLE');
      const tx = validateRelay(Buffer.from(raw, 'base64'), prepared, state);
      const balanced = await providers.walletProvider.balanceTx(tx);
      return { transactionId: balanced.identifiers()[0], transaction: Buffer.from(balanced.serialize()).toString('base64') };
    }),
    submitRelay: (raw: string) => queue(async () => {
      const { providers } = await init();
      await providers.midnightProvider.submitTx(ledgerApi.Transaction.deserialize('signature', 'proof', 'binding', Buffer.from(raw, 'base64')));
    }),
  });
  return { operator, deployEvent, operatorKey, stop };
};
