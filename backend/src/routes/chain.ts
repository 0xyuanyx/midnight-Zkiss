import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { one } from "../db.js";
import {
  router,
  result,
  need,
  providerCall,
  fail,
  id,
  hash,
  token,
  canonical,
  room,
  limit,
} from "../http.js";
import type { Config } from "../config.js";
import type {
  MidnightAdapter,
  Binding,
  Verification,
} from "../adapters/midnight.js";
import { eventChain, enqueue } from "../chain-context.js";
import type { PrepareContext } from "../adapters/midnight.js";
import { applyVerification } from "../worker.js";
export function operation(o: Record<string, any>) {
  return {
    id: o.id,
    mode: o.mode,
    purpose: o.purpose,
    status: o.status,
    transactionId: o.transaction_id,
    effectApplied: o.effect_applied,
    failureCode: o.failure_code,
    updatedAt: o.updated_at,
    retryAfterMs: 1500,
  };
}
export function chain(
  app: FastifyInstance,
  pool: Pool,
  config: Config,
  adapter?: MidnightAdapter,
) {
  const route = router(app, pool, config),
    E = "/events/:eventId";
  route(
    "POST",
    E + "/midnight/ticket",
    async (c) => {
      need(
        adapter?.mode === config.mode && adapter?.capabilities.admission,
        503,
        "FEATURE_NOT_READY",
      );
      const event = eventChain(c.event);
      const b = z
        .object({ ticketLeaf: z.string().regex(/^[a-f0-9]{64}$/) })
        .strict()
        .parse(c.request.body);
      need(
        !c.p.ticket_leaf || c.p.ticket_leaf === b.ticketLeaf,
        409,
        "TICKET_LEAF_CHANGED",
      );
      need(
        c.p.admission_status !== "active" || c.p.ticket_status === "issued",
        409,
        "ALREADY_ADMITTED",
      );
      const other = await one(
        c.db,
        "SELECT id FROM participants WHERE event_id=$1 AND ticket_leaf=$2 AND id<>$3",
        [c.event.id, b.ticketLeaf, c.uid],
      );
      need(!other, 409, "TICKET_LEAF_IN_USE");
      if (!c.p.ticket_leaf) {
        await c.db.query(
          "UPDATE participants SET ticket_leaf=$2,ticket_status='issuing',ticket_event=$3 WHERE id=$1",
          [c.uid, b.ticketLeaf, JSON.stringify(event)],
        );
        await enqueue(c.db, c.event.id, "ticket", c.uid, config.mode, event);
      }
      const p = (await one(
        c.db,
        "SELECT ticket_leaf,ticket_status FROM participants WHERE id=$1",
        [c.uid],
      ))!;
      return result(
        { ticketLeaf: p.ticket_leaf, status: p.ticket_status },
        p.ticket_status === "issued" ? 200 : 202,
      );
    },
    { active: false, phase: "join", freshResponse: true },
  );
  route(
    "POST",
    E + "/chain-intents",
    async (c) => {
      need(adapter && adapter.mode === config.mode, 503, "FEATURE_NOT_READY");
      await limit(c, "chain", 20);
      const b = z
        .discriminatedUnion("purpose", [
          z
            .object({
              purpose: z.literal("admission"),
              admissionNullifier: z.string().regex(/^[a-f0-9]{64}$/).optional(),
              devicePublicKey: z
                .string()
                .max(88)
                .refine((v) => Buffer.from(v, "base64").length === 32),
              deviceKeyVersion: z.number().int().positive(),
            })
            .strict(),
          z
            .object({
              purpose: z.literal("reveal_approval"),
              revealRequestId: z.string().min(1).max(200),
              transcriptHash: z.string().regex(/^[a-f0-9]{64}$/),
            })
            .strict(),
        ])
        .parse(c.request.body);
      const context: PrepareContext = { event: eventChain(c.event) };
      let revealId: string | null = null,
        transcript: string | null = null,
        deadline = Date.now() + 10 * 60 * 1000;
      if (b.purpose === "admission") {
        need(adapter.capabilities.admission, 503, "FEATURE_NOT_READY");
        need(config.mode !== "real" || b.admissionNullifier, 400, "ADMISSION_NULLIFIER_REQUIRED");
        need(!c.p.admission_nullifier || c.p.admission_nullifier === b.admissionNullifier, 409, "ADMISSION_NULLIFIER_CHANGED");
        need(c.p.admission_status !== "active", 409, "ALREADY_ADMITTED");
        need(c.p.ticket_status === "issued", 409, "TICKET_NOT_ISSUED");
        need(
          c.p.ticket_event &&
            canonical(c.p.ticket_event) === canonical(context.event),
          409,
          "CHAIN_SCOPE_CHANGED",
        );
        need(
          c.event.status === "open" &&
            new Date(c.event.join_until).getTime() > Date.now(),
          409,
          "EVENT_CLOSED",
        );
        if (
          c.p.device_key_version &&
          c.p.device_public_key !== b.devicePublicKey &&
          b.deviceKeyVersion <= c.p.device_key_version
        )
          fail(409, "KEY_VERSION_CHANGED");
        if (b.deviceKeyVersion < c.p.device_key_version)
          fail(409, "KEY_VERSION_CHANGED");
        await c.db.query(
          "UPDATE participants SET device_public_key=$2,device_key_version=$3,admission_status='admission_pending',admission_nullifier=COALESCE(admission_nullifier,$4) WHERE id=$1",
          [c.uid, b.devicePublicKey, b.deviceKeyVersion, b.admissionNullifier ?? null],
        );
        c.p.device_public_key = b.devicePublicKey;
        c.p.device_key_version = b.deviceKeyVersion;
        deadline = Math.min(deadline, new Date(c.event.join_until).getTime());
      } else {
        need(
          adapter.capabilities.reveal && c.event.sns_reveal,
          503,
          "FEATURE_NOT_READY",
        );
        need(c.p.admission_status === "active", 403, "ADMISSION_REQUIRED");
        const r = await one(
          c.db,
          "SELECT * FROM reveal_requests WHERE id=$1 AND event_id=$2 AND (a=$3 OR b=$3)",
          [b.revealRequestId, c.event.id, c.uid],
        );
        need(r);
        const conversation = await room(c, r.conversation_id, true);
        need(
          conversation.origin !== "question_reply" ||
            adapter.capabilities.anonymousReveal,
          503,
          "FEATURE_NOT_READY",
        );
        need(
          r.status === "awaiting_chain" && r.decisions[c.uid] === "accepted",
          409,
          "REVEAL_NOT_READY",
        );
        need(r.transcript_hash === b.transcriptHash, 409, "VERSION_CONFLICT");
        need(
          new Date(r.expires_at).getTime() > Date.now(),
          409,
          "CONSENT_EXPIRED",
        );
        need(
          r.chain_event &&
            canonical(r.chain_event) === canonical(context.event),
          409,
          "CHAIN_SCOPE_CHANGED",
        );
        context.reveal = {
          roomId: r.chain_room_id,
          slotIndex: r.a === c.uid ? 0 : 1,
          anonymous: conversation.origin === "question_reply",
        };
        revealId = r.id;
        transcript = r.transcript_hash;
        deadline = Math.min(deadline, new Date(r.expires_at).getTime());
      }
      const intentId = id("intent"),
        operationId = id("op");
      const binding: Binding = {
        version: "zkiss-backend-binding-v1",
        intentId,
        purpose: b.purpose,
        eventId: c.event.id,
        participantId: c.uid,
        devicePublicKey: c.p.device_public_key,
        deviceKeyVersion: c.p.device_key_version,
        revealRequestId: revealId,
        transcriptHash: transcript,
        admissionNullifier: b.purpose === "admission" ? (b.admissionNullifier ?? null) : null,
        nonce: token(),
        expiresAt: new Date(Math.floor(deadline / 1000) * 1000).toISOString(),
      };
      const bindingHash = hash(canonical(binding));
      const prepared = await providerCall(() =>
        adapter.prepare(binding, bindingHash, context),
      );
      need(
        prepared.protocolVersion &&
          prepared.network &&
          prepared.contractAddress &&
          prepared.circuit &&
          prepared.publicPayload,
        503,
        "FEATURE_NOT_READY",
      );
      need(
        prepared.network === context.event.network &&
          prepared.contractAddress === context.event.contractAddress,
        409,
        "CHAIN_SCOPE_CHANGED",
      );
      if (revealId) {
        const scope = {
          network: prepared.network,
          contractAddress: prepared.contractAddress,
          protocolVersion: prepared.protocolVersion,
          circuit: prepared.circuit,
        };
        const request = (await one(
          c.db,
          "SELECT approval_scope FROM reveal_requests WHERE id=$1",
          [revealId],
        ))!;
        need(
          !request.approval_scope ||
            canonical(request.approval_scope) === canonical(scope),
          409,
          "CHAIN_SCOPE_CHANGED",
        );
        await c.db.query(
          "UPDATE reveal_requests SET approval_scope=$2 WHERE id=$1",
          [revealId, JSON.stringify(scope)],
        );
      }
      await c.db.query(
        "INSERT INTO chain_intents(id,event_id,owner_id,purpose,reveal_request_id,binding,binding_hash,prepared,mode,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [
          intentId,
          c.event.id,
          c.uid,
          b.purpose,
          revealId,
          JSON.stringify(binding),
          bindingHash,
          JSON.stringify(prepared),
          config.mode,
          binding.expiresAt,
        ],
      );
      await c.db.query(
        "INSERT INTO operations(id,intent_id,owner_id) VALUES($1,$2,$3)",
        [operationId, intentId, c.uid],
      );
      return result(
        {
          id: intentId,
          operationId,
          mode: config.mode,
          purpose: b.purpose,
          ...prepared,
          nonce: binding.nonce,
          expiresAt: binding.expiresAt,
          bindingHash,
          publicPayloadHash: hash(
            Buffer.from(prepared.publicPayload, "base64url"),
          ),
        },
        201,
      );
    },
    { active: false, idempotent: true },
  );
  route(
    "POST",
    E + "/chain-intents/:intentId/transactions",
    async (c) => {
      const b = z
        .object({ transactionId: z.string().min(1).max(512) })
        .strict()
        .parse(c.request.body);
      const i = await one(
        c.db,
        "SELECT * FROM chain_intents WHERE id=$1 AND owner_id=$2 AND event_id=$3",
        [c.params.intentId, c.uid, c.event.id],
      );
      need(i);
      need(
        new Date(i.expires_at).getTime() > Date.now(),
        409,
        "CONSENT_EXPIRED",
      );
      const o = (await one(
        c.db,
        "SELECT * FROM operations WHERE intent_id=$1",
        [i.id],
      ))!;
      if (o.transaction_id && o.transaction_id !== b.transactionId)
        fail(409, "IDEMPOTENCY_CONFLICT");
      if (!o.transaction_id)
        await c.db.query(
          "UPDATE operations SET transaction_id=$2,status='submitted',updated_at=now() WHERE id=$1",
          [o.id, b.transactionId],
        );
      const updated = await one(c.db, "SELECT * FROM operations WHERE id=$1", [
        o.id,
      ]);
      return result(
        operation({ ...updated, mode: i.mode, purpose: i.purpose }),
        202,
      );
    },
    { active: false, idempotent: true },
  );
  route(
    "GET",
    E + "/operations/:operationId",
    async (c) => {
      const o = await one(
        c.db,
        "SELECT o.*,i.mode,i.purpose FROM operations o JOIN chain_intents i ON i.id=o.intent_id WHERE o.id=$1 AND o.owner_id=$2 AND i.event_id=$3",
        [c.params.operationId, c.uid, c.event.id],
      );
      need(o);
      return result(operation(o));
    },
    { active: false },
  );
  if (config.mode === "demo")
    route(
      "POST",
      E + "/demo/chain-intents/:intentId/resolution",
      async (c) => {
        const b = z
          .object({ outcome: z.enum(["succeeded", "failed", "expired"]) })
          .strict()
          .parse(c.request.body);
        const o = await one(
          c.db,
          "SELECT o.*,i.prepared,i.binding_hash,i.mode,i.purpose FROM operations o JOIN chain_intents i ON i.id=o.intent_id WHERE i.id=$1 AND o.owner_id=$2 AND i.event_id=$3 AND i.mode='demo'",
          [c.params.intentId, c.uid, c.event.id],
        );
        need(o);
        if (o.status === "awaiting_submission")
          await c.db.query(
            "UPDATE operations SET status='submitted',transaction_id=$2 WHERE id=$1",
            [o.id, "demo:" + o.id],
          );
        if (b.outcome === "expired")
          await c.db.query(
            "UPDATE chain_intents SET expires_at=now() WHERE id=$1",
            [c.params.intentId],
          );
        const v: Verification =
          b.outcome === "succeeded"
            ? {
                status: "succeeded",
                bindingHash: o.binding_hash,
                network: o.prepared.network,
                contractAddress: o.prepared.contractAddress,
                purpose: o.purpose,
                evidenceRef: "demo:" + o.id,
              }
            : {
                status: "failed",
                reasonCode:
                  b.outcome === "expired" ? "EXPIRED" : "DEMO_FAILURE",
              };
        await applyVerification(c.db, o.id, v);
        return result(
          operation({
            ...(await one(c.db, "SELECT * FROM operations WHERE id=$1", [
              o.id,
            ])),
            mode: "demo",
            purpose: o.purpose,
          }),
        );
      },
      { active: false, idempotent: true },
    );
}
