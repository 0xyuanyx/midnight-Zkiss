import { createHash } from "node:crypto";
import type { MidnightAdapter, MidnightOperator } from "./midnight.js";
/** Explicit simulation: no chain, ownership proof, or usable encryption key generation. */
export const demoMidnight: MidnightAdapter = {
  mode: "demo",
  capabilities: { admission: true, reveal: true, anonymousReveal: true },
  async prepare(_binding, bindingHash, context) {
    return {
      protocolVersion: "demo-v2",
      network: context.event.network,
      contractAddress: context.event.contractAddress,
      circuit: "demo",
      publicPayload: Buffer.from("demo:" + bindingHash).toString("base64url"),
      zkManifestUrl: null,
    };
  },
  async verify() {
    return { status: "pending" };
  },
  async revealTerms(input) {
    const terms = Buffer.from(
      JSON.stringify({ demo: true, ...input }),
    ).toString("base64url");
    return {
      terms,
      transcriptHash: createHash("sha256").update(terms).digest("hex"),
    };
  },
  async revealStatus() {
    return "authorized";
  },
};
/** Process-local demo state only; real operators MUST use chain readback. */
export function createDemoOperator(): MidnightOperator {
  const tickets = new Set<string>(),
    rooms = new Map<string, "open" | "closed">();
  const key = (e: { contractAddress: string }, id: string) =>
    e.contractAddress + ":" + id;
  return {
    mode: "demo",
    async isTicketIssued(e, leaf) {
      return tickets.has(key(e, leaf));
    },
    async issueTicket(e, leaf) {
      tickets.add(key(e, leaf));
      return { transactionId: "demo:ticket:" + leaf };
    },
    async roomState(e, id) {
      return rooms.get(key(e, id)) ?? "absent";
    },
    async openRoom(e, r) {
      rooms.set(key(e, r.roomId), "open");
      return { transactionId: "demo:open:" + r.roomId };
    },
    async closeRoom(e, id) {
      rooms.set(key(e, id), "closed");
      return { transactionId: "demo:close:" + id };
    },
  };
}
