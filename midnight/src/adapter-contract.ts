// Backend/Midnight integration boundary **v2 (proposal, 2026-09-25)** — see CODEX_HANDOFF_V2.md.
// v1 source of truth was backend/src/adapters/midnight.ts (codex/zkiss-backend 946ec85). Once Codex adopts v2,
// the backend copy becomes the source of truth again; keep both identical.

export type Purpose = 'admission' | 'reveal_approval';
export interface Binding {
  version: 'zkiss-backend-binding-v1';
  intentId: string;
  purpose: Purpose;
  eventId: string;
  participantId: string;
  devicePublicKey: string;
  deviceKeyVersion: number;
  revealRequestId: string | null;
  transcriptHash: string | null;
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
  | { status: 'pending' | 'reconciling' | 'failed' | 'partial_failure'; reasonCode?: string }
  | { status: 'succeeded'; bindingHash: string; network: string; contractAddress: string; purpose: Purpose; evidenceRef: string };

// ---- v2 additions ----
export interface EventChain {
  contractAddress: string; // hex
  eventScope: string; // 64 hex
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
  terms: string; // base64url of encodeTerms()
}
export type RevealChainStatus = 'awaiting' | 'authorized' | 'closed' | 'unknown';

export interface MidnightAdapter {
  mode: 'real' | 'demo';
  capabilities: { admission: boolean; reveal: boolean; anonymousReveal: boolean };
  /** publicPayload is canonical PUBLIC bytes encoded as base64url, never witness data. */
  prepare(binding: Binding, bindingHash: string, context: PrepareContext): Promise<PreparedIntent>;
  /** Verify target effect against trusted chain readback, not merely tx existence. */
  verify(input: VerificationInput): Promise<Verification>;
  /** Pure computation, no chain write. */
  revealTerms(input: RevealTermsInput): Promise<RevealTermsResult>;
  /** authorized only when both slots approved the same transcript and the room is still open. */
  revealStatus(event: EventChain, transcriptHash: string): Promise<RevealChainStatus>;
}

/** Worker-only. Default export of MIDNIGHT_OPERATOR_MODULE. */
export interface MidnightOperator {
  mode: 'real' | 'demo';
  issueTicket(event: EventChain, ticketLeaf: string): Promise<{ transactionId: string }>;
  openRoom(event: EventChain, room: { roomId: string; slotA: string; slotB: string; expiresAt: string }): Promise<{ transactionId: string }>;
  closeRoom(event: EventChain, roomId: string): Promise<{ transactionId: string }>;
  isTicketIssued(event: EventChain, ticketLeaf: string): Promise<boolean>;
  roomState(event: EventChain, roomId: string): Promise<'absent' | 'open' | 'closed'>;
}
