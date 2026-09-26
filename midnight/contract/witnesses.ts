// ZKiss witness implementations for contract/zkiss.compact (compact-runtime 0.16.0).
// Everything here runs on the user's device; values never leave it except as
// ZK private inputs (see privacy notes in zkiss.compact).
import type { WitnessContext } from "@midnight-ntwrk/compact-runtime";
import type { Ledger, RoomSecrets, Witnesses } from "./managed/zkiss/contract/index.js";

export type RoomSecretsRecord = {
  /** Raw 32-byte room-scoped X25519 public key; its commit is H("zkiss:v1:rk", pk). */
  recipientPk: Uint8Array;
  /** NFC-normalised UTF-8 SNS handle, zero-padded to 64 bytes. */
  contact: Uint8Array;
  /** 32-byte random salt for persistentCommit(contact, salt). */
  contactSalt: Uint8Array;
};

export type ZkissPrivateState = {
  /** Only present on the operator's (backend's) device. */
  operatorSecret?: Uint8Array;
  /** Per-event ticket secret `s` (32 random bytes). */
  ticketSecret: Uint8Array;
  /** Keyed by lowercase hex roomId. */
  roomSecrets: Record<string, RoomSecretsRecord>;
};

// No Buffer: witnesses run on the user's device browser as well as in Node.
export const toHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

type Ctx = WitnessContext<Ledger, ZkissPrivateState>;
type Path = ReturnType<Ledger["tickets"]["pathForLeaf"]>;

/** Must equal the depth of `tickets` / `admitted` in zkiss.compact. */
export const TREE_DEPTH = 12;

// If the leaf is absent, return a structurally valid dummy path so the circuit
// itself rejects with its own assertion ("ticket not issued" / "not admitted")
// instead of the witness throwing. (tree.pathForLeaf(0n, leaf) is NOT used as the
// fallback: it throws "invalid index into sparse merkle tree" on an empty tree.)
const dummyPath = (leaf: Uint8Array): Path => ({
  leaf,
  path: Array.from({ length: TREE_DEPTH }, () => ({ sibling: { field: 0n }, goes_left: false })),
});

const pathIn = (tree: Ledger["tickets"], leaf: Uint8Array): Path =>
  tree.findPathForLeaf(leaf) ?? dummyPath(leaf);

export const witnesses: Witnesses<ZkissPrivateState> = {
  operatorSecret({ privateState }: Ctx): [ZkissPrivateState, Uint8Array] {
    if (!privateState.operatorSecret) throw new Error("operatorSecret not available in private state");
    return [privateState, privateState.operatorSecret];
  },

  ticketSecret({ privateState }: Ctx): [ZkissPrivateState, Uint8Array] {
    return [privateState, privateState.ticketSecret];
  },

  ticketPath({ privateState, ledger }: Ctx, leaf: Uint8Array): [ZkissPrivateState, Path] {
    return [privateState, pathIn(ledger.tickets, leaf)];
  },

  admittedPath({ privateState, ledger }: Ctx, leaf: Uint8Array): [ZkissPrivateState, Path] {
    return [privateState, pathIn(ledger.admitted, leaf)];
  },

  roomSecrets({ privateState }: Ctx, roomId: Uint8Array): [ZkissPrivateState, RoomSecrets] {
    const rs = privateState.roomSecrets[toHex(roomId)];
    if (!rs) throw new Error("no room secrets for this room");
    return [privateState, { recipientPk: rs.recipientPk, contact: rs.contact, contactSalt: rs.contactSalt }];
  },
};
