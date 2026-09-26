import { createHash } from "node:crypto";
import { z } from "zod";
import type { Row, Db } from "./db.js";
import type { EventChain } from "./adapters/midnight.js";
import { need } from "./http.js";
export const eventChainSchema = z
  .object({
    network: z.string().min(1).max(100),
    contractAddress: z.string().regex(/^[a-f0-9]{64}$/),
    eventScope: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export function eventChain(e: Row): EventChain {
  const r = eventChainSchema.safeParse({
    network: e.midnight_network,
    contractAddress: e.midnight_contract_address,
    eventScope: e.midnight_event_scope,
  });
  need(r.success, 503, "CHAIN_NOT_CONFIGURED");
  return r.data;
}
export async function enqueue(
  db: Db,
  eventId: string,
  kind: "ticket" | "terms" | "close" | "open",
  resourceId: string,
  mode: "real" | "demo",
  event: EventChain,
) {
  await db.query(
    "INSERT INTO chain_jobs(event_id,kind,resource_id,mode,chain_event) VALUES($1,$2,$3,$4,$5) ON CONFLICT(kind,resource_id) DO NOTHING",
    [eventId, kind, resourceId, mode, JSON.stringify(event)],
  );
}
export async function enqueueClose(db: Db, r: Row, mode: "real" | "demo") {
  if (r.chain_room_id && r.chain_event)
    await enqueue(db, r.event_id, "close", r.id, mode, r.chain_event);
}

export function roomChainContext(c: Row, e: Row) {
  const chain = c.chain_event ?? eventChain(e);
  return { ...chain, roomId: c.chain_room_id ?? createHash('sha256').update(JSON.stringify([chain, c.id])).digest('hex') };
}
