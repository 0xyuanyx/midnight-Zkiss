// ZKiss witness implementations for sns/zkiss.compact (compact-runtime 0.16.0).
// Everything here runs on the user's device; values never leave it except as
// ZK private inputs (see privacy notes in zkiss.compact).
import type { WitnessContext } from "@midnight-ntwrk/compact-runtime";
import type { Ledger, RoomSecrets, Witnesses } from "./managed/sns/contract/index.js";

export type RoomSecretsRecord = {
  /** Raw 32-byte room-scoped X25519 public key; its commit is H("zkiss:sns:v1:rk", pk). */
  recipientPk: Uint8Array;
  /** NFC-normalised UTF-8 SNS handle, zero-padded to 64 bytes. */
  contact: Uint8Array;
  /** 32-byte random salt for persistentCommit(contact, salt). */
  contactSalt: Uint8Array;
};

export type ZkissPrivateState = {
  /** Only present on the operator's (backend's) device. */
  operatorSecret?: Uint8Array;
  /** Per-session device secret `s` (32 random bytes). */
  participantSecret: Uint8Array;
  /** Keyed by lowercase hex roomId. */
  roomSecrets: Record<string, RoomSecretsRecord>;
};

// No Buffer: witnesses run on the user's device browser as well as in Node.
export const toHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

type Ctx = WitnessContext<Ledger, ZkissPrivateState>;
export const witnesses: Witnesses<ZkissPrivateState> = {
  operatorSecret({ privateState }: Ctx): [ZkissPrivateState, Uint8Array] {
    if (!privateState.operatorSecret) throw new Error("operatorSecret not available in private state");
    return [privateState, privateState.operatorSecret];
  },

  participantSecret({ privateState }: Ctx): [ZkissPrivateState, Uint8Array] {
    return [privateState, privateState.participantSecret];
  },


  roomSecrets({ privateState }: Ctx, roomId: Uint8Array): [ZkissPrivateState, RoomSecrets] {
    const rs = privateState.roomSecrets[toHex(roomId)];
    if (!rs) throw new Error("no room secrets for this room");
    return [privateState, { recipientPk: rs.recipientPk, contact: rs.contact, contactSalt: rs.contactSalt }];
  },
};
