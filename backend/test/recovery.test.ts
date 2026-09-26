import { demoMidnight } from "../src/adapters/demo-midnight.js";
import { test, expect } from "vitest";
import { fixture, issuedTicket, user, activeUser, call } from "./helpers.js";
import * as worker from "../src/worker.js";
import type {
  MidnightAdapter,
  Verification,
} from "../src/adapters/midnight.js";
const admission = {
  purpose: "admission",
  devicePublicKey: Buffer.alloc(32, 1).toString("base64"),
  deviceKeyVersion: 1,
};
test("worker expires abandoned intents and closed-event rooms without an adapter", async () => {
  const f = await fixture();
  try {
    const a = await user(f);
    await issuedTicket(f, a);
    const i = (
      await call(f, a, "POST", "/events/evt/chain-intents", admission)
    ).json().data;
    await f.pool.query(
      "UPDATE chain_intents SET expires_at=now()-interval '1 second' WHERE id=$1",
      [i.id],
    );
    const maintain = (worker as any).maintain;
    expect(typeof maintain).toBe("function");
    await maintain(f.pool);
    expect(
      (
        await call(f, a, "GET", `/events/evt/operations/${i.operationId}`)
      ).json().data.status,
    ).toBe("expired");
    const b = await activeUser(f),
      c = await activeUser(f);
    await call(f, b, "POST", "/events/evt/likes", { targetProfileId: c.id });
    const r = (
      await call(f, c, "POST", "/events/evt/likes", { targetProfileId: b.id })
    ).json().data.conversationId;
    await f.pool.query(
      "UPDATE events SET chat_until=now()-interval '1 second' WHERE id='evt'",
    );
    await maintain(f.pool);
    expect(
      (await f.pool.query("SELECT status FROM conversations WHERE id=$1", [r]))
        .rows[0].status,
    ).toBe("expired");
  } finally {
    await f.close();
  }
});
test("reconciliation and partial failures never grant admission; wrong network is rejected", async () => {
  let verdict: Verification = { status: "reconciling" };
  const adapter: MidnightAdapter = {
    ...demoMidnight,
    mode: "real",
    capabilities: { admission: true, reveal: false, anonymousReveal: false },
    async prepare() {
      return {
        protocolVersion: "fixture",
        network: "test",
        contractAddress: "a".repeat(64),
        circuit: "join",
        publicPayload: "eA",
        zkManifestUrl: null,
      };
    },
    async verify() {
      return verdict;
    },
  };
  const f = await fixture("real", { midnight: adapter });
  try {
    const a = await user(f);
    await issuedTicket(f, a);
    const i = (
      await call(f, a, "POST", "/events/evt/chain-intents", admission)
    ).json().data;
    await call(f, a, "POST", `/events/evt/chain-intents/${i.id}/transactions`, {
      transactionId: "x",
    });
    await worker.reconcile(f.pool, adapter);
    expect(
      (
        await call(f, a, "GET", `/events/evt/operations/${i.operationId}`)
      ).json().data.status,
    ).toBe("reconciling");
    verdict = { status: "partial_failure", reasonCode: "PARTIAL_FAILURE" };
    await worker.reconcile(f.pool, adapter);
    expect(
      (await call(f, a, "GET", "/me")).json().data.admissionStatus,
    ).not.toBe("active");
    const j = (
      await call(f, a, "POST", "/events/evt/chain-intents", admission)
    ).json().data;
    await call(f, a, "POST", `/events/evt/chain-intents/${j.id}/transactions`, {
      transactionId: "y",
    });
    verdict = {
      status: "succeeded",
      bindingHash: j.bindingHash,
      network: "wrong",
      contractAddress: "a".repeat(64),
      purpose: "admission",
      evidenceRef: "x",
    };
    await worker.reconcile(f.pool, adapter);
    expect(
      (
        await call(f, a, "GET", `/events/evt/operations/${j.operationId}`)
      ).json().data.failureCode,
    ).toBe("INVALID_BINDING");
  } finally {
    await f.close();
  }
});
