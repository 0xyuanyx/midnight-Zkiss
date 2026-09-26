/** Backend/Midnight integration boundary v2. This file implements no ZK verification. */
export type Purpose = "admission" | "reveal_approval";
export interface Binding {
  version: "zkiss-backend-binding-v1";
  intentId: string;
  purpose: Purpose;
  eventId: string;
  participantId: string;
  devicePublicKey: string;
  deviceKeyVersion: number;
  revealRequestId: string | null;
  transcriptHash: string | null;
  admissionNullifier?: string | null;
  nonce: string;
  expiresAt: string;
}
export interface PreparedIntent {
  protocolVersion: string;
  network: string;
  contractAddress: string;
  circuit: string;
  publicPayload: string;
  zkManifestUrl: string | null;
}
export interface VerificationInput extends PreparedIntent {
  intentId: string;
  purpose: Purpose;
  bindingHash: string;
  expiresAt: string;
  transactionId: string;
}
export type Verification =
  | {
      status: "pending" | "reconciling" | "failed" | "partial_failure";
      reasonCode?: string;
    }
  | {
      status: "succeeded";
      bindingHash: string;
      network: string;
      contractAddress: string;
      purpose: Purpose;
      evidenceRef: string;
    };
export interface EventChain {
  contractAddress: string;
  eventScope: string;
  network: string;
}
export interface PrepareContext {
  event: EventChain;
  reveal?: { roomId: string; slotIndex: 0 | 1; anonymous: boolean };
}
export interface RevealTermsInput {
  event: EventChain;
  roomId: string;
  slots: [string, string];
  keyCommits: [string, string];
  contactCommits: [string, string];
  expiresAt: string;
  policyVersion: number;
}
export interface RevealTermsResult {
  transcriptHash: string;
  terms: string;
}
export type RevealChainStatus =
  | "awaiting"
  | "authorized"
  | "closed"
  | "unknown";
export interface MidnightAdapter {
  mode: "real" | "demo";
  capabilities: {
    admission: boolean;
    reveal: boolean;
    anonymousReveal: boolean;
  };
  prepare(
    binding: Binding,
    bindingHash: string,
    context: PrepareContext,
  ): Promise<PreparedIntent>;
  verify(input: VerificationInput): Promise<Verification>;
  revealTerms(input: RevealTermsInput): Promise<RevealTermsResult>;
  revealStatus(
    event: EventChain,
    transcriptHash: string,
  ): Promise<RevealChainStatus>;
}
/** Worker only. Operator secrets are read by the installed module, never by HTTP. */
export interface MidnightOperator {
  mode: "real" | "demo";
  issueTicket(
    event: EventChain,
    ticketLeaf: string,
  ): Promise<{ transactionId: string }>;
  openRoom(
    event: EventChain,
    room: { roomId: string; slotA: string; slotB: string; expiresAt: string },
  ): Promise<{ transactionId: string }>;
  closeRoom(
    event: EventChain,
    roomId: string,
  ): Promise<{ transactionId: string }>;
  isTicketIssued(event: EventChain, ticketLeaf: string): Promise<boolean>;
  roomState(
    event: EventChain,
    roomId: string,
  ): Promise<"absent" | "open" | "closed">;
}
