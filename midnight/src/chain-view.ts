// Read side of the chain for the backend adapter. The indexer is the trusted readback source here
// (a self-hosted indexer, or one the operator trusts); nothing the client submits is used as evidence.
import { bytesToHex } from './encoding.js';

export type RoomView = { slotA: Uint8Array; slotB: Uint8Array; expiresAt: bigint; open: boolean };
export type ApprovalView = { roomId: Uint8Array; a: boolean; b: boolean };
export type ConsentView = { transcript: Uint8Array; slot: number; expiresAt: bigint };

export interface ChainSnapshot {
  blockRef: string; // "<height>:<hash>" of the state that was read
  blockTimeSec: bigint | null;
  eventScope: Uint8Array;
  admissionExpiry(admissionKey: Uint8Array): bigint | undefined;
  /** consents[consentKey(bindingHash, slotValue)]: only the owner of that slot can have written it. */
  consent(bindingHash: Uint8Array, slotValue: Uint8Array): ConsentView | undefined;
  approval(transcript: Uint8Array): ApprovalView | undefined;
  room(roomId: Uint8Array): RoomView | undefined;
}

export type TxOutcome = 'unknown' | 'success' | 'partial' | 'failure';

export interface ChainView {
  snapshot(contractAddress: string): Promise<ChainSnapshot | null>;
  /** Outcome of a tx by identifier (as returned in callTx().public.txId). 'unknown' when not indexed. */
  txOutcome(transactionId: string): Promise<TxOutcome>;
}

/** Subset of the generated `ledger(state)` object that the adapter needs (see contract/managed/zkiss). */
export interface ZkissLedgerLike {
  eventScope: Uint8Array;
  admissions: { member(k: Uint8Array): boolean; lookup(k: Uint8Array): bigint };
  consents: { member(k: Uint8Array): boolean; lookup(k: Uint8Array): { transcript: Uint8Array; slot: bigint | number; expiresAt: bigint } };
  approvedA: { member(k: Uint8Array): boolean; lookup(k: Uint8Array): Uint8Array };
  approvedB: { member(k: Uint8Array): boolean; lookup(k: Uint8Array): Uint8Array };
  rooms: { member(k: Uint8Array): boolean; lookup(k: Uint8Array): RoomView };
}

export const snapshotFromLedger = (
  l: ZkissLedgerLike,
  blockRef: string,
  blockTimeSec: bigint | null,
  consentKey: (bindingHash: Uint8Array, slotValue: Uint8Array) => Uint8Array,
): ChainSnapshot => ({
  blockRef,
  blockTimeSec,
  eventScope: l.eventScope,
  admissionExpiry: (k) => (l.admissions.member(k) ? l.admissions.lookup(k) : undefined),
  consent: (bh, slotValue) => {
    const k = consentKey(bh, slotValue);
    if (!l.consents.member(k)) return undefined;
    const c = l.consents.lookup(k);
    return { transcript: c.transcript, slot: Number(c.slot), expiresAt: c.expiresAt };
  },
  approval: (tr) => {
    const a = l.approvedA.member(tr);
    const b = l.approvedB.member(tr);
    if (!a && !b) return undefined;
    const roomA = a ? l.approvedA.lookup(tr) : undefined;
    const roomB = b ? l.approvedB.lookup(tr) : undefined;
    // 두 맵의 roomId는 같은 transcript에서 나오므로 항상 같다(transcript가 roomId를 포함).
    return { roomId: (roomA ?? roomB)!, a, b };
  },
  room: (k) => (l.rooms.member(k) ? l.rooms.lookup(k) : undefined),
});

type Gql = <T>(query: string, variables: Record<string, unknown>) => Promise<T>;

const gqlClient = (url: string, fetchImpl: typeof fetch): Gql => async (query, variables) => {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`indexer HTTP ${res.status}`);
  const body = (await res.json()) as { data?: any; errors?: unknown[] };
  if (body.errors?.length) throw new Error(`indexer error ${JSON.stringify(body.errors).slice(0, 200)}`);
  return body.data;
};

const STATE_QUERY = `query ZkissState($address: HexEncoded!) {
  contractAction(address: $address) { state transaction { block { height hash timestamp } } }
  block { height hash timestamp }
}`;

const TX_QUERY = `query ZkissTx($offset: TransactionOffset!) {
  transactions(offset: $offset) { ... on RegularTransaction { transactionResult { status } } }
}`;

export type IndexerChainViewOptions = {
  indexerUrl: string; // e.g. http://127.0.0.1:8088/api/v3/graphql
  /** Decodes the hex `state` of a contract action with the compiled contract (see ledger-decoder.ts). */
  decode: (stateHex: string) => ZkissLedgerLike;
  consentKey: (bindingHash: Uint8Array, slotValue: Uint8Array) => Uint8Array;
  fetch?: typeof fetch;
};

/**
 * Block timestamps: the indexer reports a UNIX timestamp; this view treats values above 1e12 as milliseconds.
 * The unit was checked against a Local Devnet run (see MIDNIGHT_IMPLEMENTATION_STATUS.md), not other networks.
 */
const toSeconds = (ts: number | null | undefined): bigint | null => {
  if (ts === null || ts === undefined) return null;
  return BigInt(ts > 1e12 ? Math.floor(ts / 1000) : ts);
};

export const indexerChainView = (o: IndexerChainViewOptions): ChainView => {
  const gql = gqlClient(o.indexerUrl, o.fetch ?? fetch);
  return {
    async snapshot(contractAddress) {
      const d = await gql<any>(STATE_QUERY, { address: contractAddress });
      const action = d?.contractAction;
      if (!action?.state) return null;
      const latest = d.block;
      const ref = latest ? `${latest.height}:${latest.hash}` : `${action.transaction?.block?.height}:${action.transaction?.block?.hash}`;
      return snapshotFromLedger(o.decode(action.state), ref, toSeconds(latest?.timestamp), o.consentKey);
    },
    async txOutcome(transactionId) {
      if (!/^[0-9a-fA-F]+$/.test(transactionId)) return 'unknown';
      const d = await gql<any>(TX_QUERY, { offset: { identifier: transactionId } });
      const txs: any[] = d?.transactions ?? [];
      const status = txs.find((t) => t?.transactionResult)?.transactionResult?.status;
      if (status === 'SUCCESS') return 'success';
      if (status === 'PARTIAL_SUCCESS') return 'partial';
      if (status === 'FAILURE') return 'failure';
      return 'unknown';
    },
  };
};

export { bytesToHex };
