import { randomBytes } from "node:crypto";
import { eventChain, enqueue } from "../chain-context.js";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { one, type Row } from "../db.js";
import {
  router,
  result,
  need,
  providerCall,
  emit,
  id,
  canonical,
  checkVersion,
  room,
  limit,
  type Ctx,
} from "../http.js";
import type { Config } from "../config.js";
import type { MidnightAdapter } from "../adapters/midnight.js";
import { contact } from "../dto.js";
const hex = z.string().regex(/^[a-f0-9]{64}$/);
const base64 = (min: number, max: number) =>
  z
    .string()
    .max(Math.ceil(max / 3) * 4 + 4)
    .regex(/^[A-Za-z0-9+/]*={0,2}$/)
    .refine((v) => {
      const n = Buffer.from(v, "base64").length;
      return n >= min && n <= max;
    });
const encrypted = z
  .object({
    suite: z.literal("hpke-x25519-hkdfsha256-aes128gcm-v1"),
    enc: base64(32, 32),
    ciphertext: base64(17, 4096),
    contextHash: hex,
    recipientKeyVersion: z.number().int().positive(),
  })
  .strict();
const live = [
  "collecting",
  "requested",
  "awaiting_chain",
  "authorized",
  "ready",
];
async function get(c: Ctx) {
  const r = await one(
    c.db,
    "SELECT * FROM reveal_requests WHERE id=$1 AND event_id=$2 AND (a=$3 OR b=$3)",
    [c.params.requestId, c.event.id, c.uid],
  );
  need(r);
  return r;
}
export function revealDto(r: Row, uid: string) {
  const a = r.a === uid,
    peer = a ? r.b : r.a;
  const status =
    live.includes(r.status) && new Date(r.expires_at).getTime() <= Date.now()
      ? "expired"
      : r.status;
  return {
    id: r.id,
    conversationId: r.conversation_id,
    version: r.version,
    status,
    mySlotIndex: a ? 0 : 1,
    myDecision: r.decisions[uid] ?? "pending",
    peerDecision: r.decisions[peer] ?? "pending",
    transcriptHash: r.transcript_hash,
    terms: r.transcript_payload,
    chainRoomId: r.chain_room_id,
    eventScope: r.chain_event?.eventScope ?? null,
    contractAddress: r.chain_event?.contractAddress ?? null,
    network: r.chain_event?.network ?? null,
    myMaterialReady: !!r.room_material?.[uid],
    peerMaterialReady: !!r.room_material?.[peer],
    expiresAt: r.expires_at,
    myContactVersion: a ? r.a_contact : r.b_contact,
    peerContactVersion: a ? r.b_contact : r.a_contact,
    myEnvelopeReady: !!r.envelopes[uid],
    peerEnvelopeReady: !!r.envelopes[peer],
    peerEncryptionKey: ["authorized", "ready", "released"].includes(status)
      ? r.key_material[a ? 1 : 0]
      : null,
  };
}
export function reveal(
  app: FastifyInstance,
  pool: Pool,
  config: Config,
  adapter?: MidnightAdapter,
) {
  const route = router(app, pool, config),
    E = "/events/:eventId";
  const available = (c: Ctx) =>
    need(
      c.event.sns_reveal &&
        adapter?.mode === config.mode &&
        adapter?.capabilities.reveal &&
        typeof adapter.revealTerms === "function" &&
        typeof adapter.revealStatus === "function",
      503,
      "FEATURE_NOT_READY",
    );
  route("PUT", E + "/me/contact-vault", async (c) => {
    available(c);
    const b = z
      .object({
        expectedVersion: z.number().int().min(0),
        commitment: hex,
        ownerEnvelope: encrypted,
      })
      .strict()
      .parse(c.request.body);
    checkVersion(c.p.contact_version, b.expectedVersion);
    need(
      c.p.device_key_version === b.ownerEnvelope.recipientKeyVersion,
      409,
      "KEY_VERSION_CHANGED",
    );
    const cancelled = await c.db.query(
      "UPDATE reveal_requests SET status='cancelled',version=version+1 WHERE (a=$1 OR b=$1) AND status=ANY($2::text[]) RETURNING *",
      [c.uid, live],
    );
    for (const r of cancelled.rows)
      for (const u of [r.a, r.b])
        await emit(
          c,
          u,
          "reveal.status_changed",
          r.id,
          r.conversation_id,
          r.version,
        );
    const p = await one(
      c.db,
      "UPDATE participants SET contact=$2,contact_version=contact_version+1 WHERE id=$1 RETURNING *",
      [
        c.uid,
        JSON.stringify({
          commitment: b.commitment,
          ownerEnvelope: b.ownerEnvelope,
        }),
      ],
    );
    return result(contact(p!));
  });
  route(
    "POST",
    E + "/conversations/:conversationId/reveal-requests",
    async (c) => {
      available(c);
      await limit(c, "reveal", 5);
      const r = await room(c, undefined, true);
      need(
        r.origin !== "question_reply" || adapter!.capabilities.anonymousReveal,
        503,
        "FEATURE_NOT_READY",
      );
      const b = z
        .object({
          expectedVersion: z.number().int().positive(),
          ownContactVersion: z.number().int().positive(),
          consent: z.literal(true),
        })
        .strict()
        .parse(c.request.body);
      checkVersion(r.version, b.expectedVersion);
      checkVersion(c.p.contact_version, b.ownContactVersion);
      await c.db.query(
        "UPDATE reveal_requests SET status='expired',version=version+1 WHERE conversation_id=$1 AND expires_at<=now() AND status=ANY($2::text[])",
        [r.id, live],
      );
      need(
        !(await one(
          c.db,
          "SELECT 1 FROM reveal_requests WHERE conversation_id=$1 AND status=ANY($2::text[])",
          [r.id, live],
        )),
        409,
        "REVEAL_ALREADY_PENDING",
      );
      const a = (await one(c.db, "SELECT * FROM participants WHERE id=$1", [
          r.a,
        ]))!,
        other = (await one(c.db, "SELECT * FROM participants WHERE id=$1", [
          r.b,
        ]))!;
      need(a.contact && other.contact, 409, "CONTACT_REQUIRED");
      const requestId = id("reveal");
      const chain = eventChain(c.event);
      need(
        !r.chain_event || canonical(r.chain_event) === canonical(chain),
        409,
        "CHAIN_SCOPE_CHANGED",
      );
      const chainRoomId = r.chain_room_id ?? randomBytes(32).toString("hex");
      if (!r.chain_room_id)
        await c.db.query(
          "UPDATE conversations SET chain_room_id=$2,chain_event=$3 WHERE id=$1",
          [r.id, chainRoomId, JSON.stringify(chain)],
        );
      const expiresAt = new Date(
        Math.floor(
          Math.min(
            Date.now() + 10 * 60 * 1000,
            new Date(c.event.chat_until).getTime(),
          ) / 1000,
        ) * 1000,
      ).toISOString();
      const row = await one(
        c.db,
        "INSERT INTO reveal_requests(id,event_id,conversation_id,a,b,a_contact,b_contact,a_key,b_key,transcript_hash,transcript_payload,key_material,decisions,expires_at,status,chain_event,chain_room_id,policy_version,mode) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'collecting',$15,$16,$17,$18) RETURNING *",
        [
          requestId,
          c.event.id,
          r.id,
          r.a,
          r.b,
          a.contact_version,
          other.contact_version,
          a.device_key_version,
          other.device_key_version,
          null,
          null,
          "[]",
          JSON.stringify({
            [c.uid]: "accepted",
            [c.uid === r.a ? r.b : r.a]: "pending",
          }),
          expiresAt,
          JSON.stringify(chain),
          chainRoomId,
          c.event.policy_version,
          config.mode,
        ],
      );
      for (const u of [r.a, r.b])
        await emit(c, u, "reveal.status_changed", row!.id, r.id, row!.version);
      return result(revealDto(row!, c.uid), 201);
    },
    { phase: "chat", idempotent: true },
  );
  route(
    "PUT",
    E + "/reveal-requests/:requestId/room-material",
    async (c) => {
      available(c);
      const r = await get(c);
      const conversation = await room(c, r.conversation_id, true);
      const b = z
        .object({
          slot: hex,
          roomPublicKey: base64(32, 32),
          keyCommit: hex,
          contactCommit: hex,
        })
        .strict()
        .parse(c.request.body);
      need(
        new Date(r.expires_at).getTime() > Date.now(),
        409,
        "CONSENT_EXPIRED",
      );
      const previous = r.room_material[c.uid];
      if (previous) {
        need(
          canonical(previous) === canonical({ ...b, version: 1 }),
          409,
          "MATERIAL_CHANGED",
        );
        return result(revealDto(r, c.uid));
      }
      need(r.status === "collecting", 409, "REVEAL_NOT_READY");
      const slots = conversation.chain_slots;
      need(!slots[c.uid] || slots[c.uid] === b.slot, 409, "SLOT_CHANGED");
      const peer = r.a === c.uid ? r.b : r.a;
      need(slots[peer] !== b.slot, 409, "SLOTS_MUST_DIFFER");
      const material = { ...r.room_material, [c.uid]: { ...b, version: 1 } };
      await c.db.query("UPDATE conversations SET chain_slots=$2 WHERE id=$1", [
        conversation.id,
        JSON.stringify({ ...slots, [c.uid]: b.slot }),
      ]);
      const updated = (await one(
        c.db,
        "UPDATE reveal_requests SET room_material=$2,version=version+1 WHERE id=$1 RETURNING *",
        [r.id, JSON.stringify(material)],
      ))!;
      if (material[r.a] && material[r.b])
        await enqueue(
          c.db,
          c.event.id,
          "terms",
          r.id,
          config.mode,
          r.chain_event,
        );
      for (const u of [r.a, r.b])
        await emit(
          c,
          u,
          "reveal.status_changed",
          r.id,
          r.conversation_id,
          updated.version,
        );
      return result(revealDto(updated, c.uid));
    },
    { phase: "chat", freshResponse: true },
  );
  route("GET", E + "/reveal-requests/:requestId", async (c) => {
    const r = await get(c);
    await room(c, r.conversation_id);
    return result(revealDto(r, c.uid));
  });
  route(
    "POST",
    E + "/reveal-requests/:requestId/decisions",
    async (c) => {
      const b = z
        .object({
          expectedVersion: z.number().int().positive(),
          transcriptHash: hex.nullable(),
          action: z.enum(["accept", "reject", "cancel"]),
        })
        .strict()
        .parse(c.request.body);
      const r = await get(c);
      checkVersion(r.version, b.expectedVersion);
      need(r.transcript_hash === b.transcriptHash, 409, "VERSION_CONFLICT");
      need(live.includes(r.status), 409, "REVEAL_NOT_READY");
      need(
        new Date(r.expires_at).getTime() > Date.now(),
        409,
        "CONSENT_EXPIRED",
      );
      const decisions = { ...r.decisions };
      let status: string;
      if (b.action === "accept") {
        available(c);
        await room(c, r.conversation_id, true);
        need(
          r.status === "requested" &&
            !!r.transcript_hash &&
            decisions[c.uid] === "pending",
          409,
          "REVEAL_NOT_READY",
        );
        decisions[c.uid] = "accepted";
        status = "awaiting_chain";
      } else if (b.action === "reject") {
        need(decisions[c.uid] === "pending", 409, "REVEAL_NOT_READY");
        decisions[c.uid] = "rejected";
        status = "rejected";
      } else {
        decisions[c.uid] = "cancelled";
        status = "cancelled";
      }
      const updated = await one(
        c.db,
        "UPDATE reveal_requests SET decisions=$2,status=$3,version=version+1 WHERE id=$1 RETURNING *",
        [r.id, JSON.stringify(decisions), status],
      );
      for (const u of [r.a, r.b])
        await emit(
          c,
          u,
          "reveal.status_changed",
          r.id,
          r.conversation_id,
          updated!.version,
        );
      return result(revealDto(updated!, c.uid));
    },
    { idempotent: true },
  );
  route(
    "PUT",
    E + "/reveal-requests/:requestId/my-envelope",
    async (c) => {
      available(c);
      const b = z
        .object({
          expectedVersion: z.number().int().positive(),
          transcriptHash: hex,
          envelope: encrypted,
        })
        .strict()
        .parse(c.request.body);
      const r = await get(c);
      need(
        r.mode === config.mode &&
          canonical(r.chain_event) === canonical(eventChain(c.event)),
        409,
        "CHAIN_SCOPE_CHANGED",
      );
      await room(c, r.conversation_id, true);
      checkVersion(r.version, b.expectedVersion);
      need(
        r.status === "authorized" && r.verified[r.a] && r.verified[r.b],
        409,
        "REVEAL_NOT_READY",
      );
      need(
        new Date(r.expires_at).getTime() > Date.now(),
        409,
        "CONSENT_EXPIRED",
      );
      need(
        r.transcript_hash === b.transcriptHash &&
          b.envelope.contextHash === r.transcript_hash,
        409,
        "VERSION_CONFLICT",
      );
      need(
        b.envelope.recipientKeyVersion ===
          r.key_material[r.a === c.uid ? 1 : 0].version,
        409,
        "KEY_VERSION_CHANGED",
      );
      need(!r.envelopes[c.uid], 409, "ENVELOPE_ALREADY_STORED");
      const current = (
        await c.db.query(
          "SELECT id,contact_version,device_key_version FROM participants WHERE id=ANY($1::text[])",
          [[r.a, r.b]],
        )
      ).rows;
      need(
        current.every(
          (p) =>
            p.contact_version === (p.id === r.a ? r.a_contact : r.b_contact) &&
            p.device_key_version === (p.id === r.a ? r.a_key : r.b_key),
        ),
        409,
        "KEY_VERSION_CHANGED",
      );
      const envelopes = { ...r.envelopes, [c.uid]: b.envelope };
      // A fresh read is required even after both intent verification effects.
      let status = "authorized";
      if (envelopes[r.a] && envelopes[r.b]) {
        let chainStatus: string = "unknown";
        try {
          chainStatus = await providerCall(() =>
            adapter!.revealStatus(r.chain_event, r.transcript_hash),
          );
        } catch {
          /* persist envelopes, worker retries readback */
        }
        if (chainStatus === "authorized") status = "released";
        else if (chainStatus === "closed") status = "cancelled";
      }
      // The readback may straddle a deadline while holding the event lock.
      if (
        new Date(r.expires_at).getTime() <= Date.now() ||
        new Date(c.event.chat_until).getTime() <= Date.now()
      )
        status = "expired";
      const updated = await one(
        c.db,
        "UPDATE reveal_requests SET envelopes=$2,status=$3,version=version+1 WHERE id=$1 RETURNING *",
        [r.id, JSON.stringify(envelopes), status],
      );
      for (const u of [r.a, r.b])
        await emit(
          c,
          u,
          "reveal.status_changed",
          r.id,
          r.conversation_id,
          updated!.version,
        );
      return result(revealDto(updated!, c.uid));
    },
    { phase: "chat" },
  );
  route("GET", E + "/reveal-requests/:requestId/peer-envelope", async (c) => {
    const r = await get(c);
    await room(c, r.conversation_id, true);
    need(r.status === "released", 409, "REVEAL_NOT_READY");
    const peer = r.a === c.uid ? r.b : r.a;
    return result(r.envelopes[peer]);
  });
}
