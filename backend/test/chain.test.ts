import { demoMidnight } from "../src/adapters/demo-midnight.js";
import { test, expect } from "vitest";
import { fixture, issuedTicket, user, call } from "./helpers.js";
import { reconcile } from "../src/worker.js";
import type { MidnightAdapter } from "../src/adapters/midnight.js";
export const trustedAdapter: MidnightAdapter = {
  ...demoMidnight,
  mode: "real",
  capabilities: { admission: true, reveal: true, anonymousReveal: true },
  async prepare() {
    return {
      protocolVersion: "test-fixture",
      network: "test",
      contractAddress: "a".repeat(64),
      circuit: "test",
      publicPayload: "cHVibGlj",
      zkManifestUrl: null,
    };
  },
  async verify(i) {
    return {
      status: "succeeded",
      bindingHash: i.bindingHash,
      network: i.network,
      contractAddress: i.contractAddress,
      purpose: i.purpose,
      evidenceRef: "fixture:" + i.intentId,
    };
  },
};
export const admission = {
  purpose: "admission",
  devicePublicKey: Buffer.alloc(32, 1).toString("base64"),
  deviceKeyVersion: 1,
};
test("demo admission is explicit; transaction reference alone cannot activate a session", async () => {
  const f = await fixture();
  try {
    const u = await user(f);
    await issuedTicket(f, u);
    const intent = await call(
      f,
      u,
      "POST",
      "/events/evt/chain-intents",
      admission,
    );
    expect(intent.statusCode).toBe(201);
    const data = intent.json().data;
    expect(data.mode).toBe("demo");
    expect(
      (
        await call(
          f,
          u,
          "POST",
          `/events/evt/chain-intents/${data.id}/transactions`,
          { transactionId: "fake-tx" },
        )
      ).statusCode,
    ).toBe(202);
    expect(
      (await call(f, u, "GET", "/me")).json().data.admissionStatus,
    ).not.toBe("active");
    const done = await call(
      f,
      u,
      "POST",
      `/events/evt/demo/chain-intents/${data.id}/resolution`,
      { outcome: "succeeded" },
    );
    expect(done.statusCode).toBe(200);
    expect((await call(f, u, "GET", "/me")).json().data.admissionStatus).toBe(
      "active",
    );
  } finally {
    await f.close();
  }
});
test("real mode without an adapter fails closed and has no demo route", async () => {
  const f = await fixture("real");
  try {
    const u = await user(f);
    await issuedTicket(f, u);
    expect(
      (await call(f, u, "POST", "/events/evt/chain-intents", admission))
        .statusCode,
    ).toBe(503);
    expect(
      (
        await call(
          f,
          u,
          "POST",
          "/events/evt/demo/chain-intents/x/resolution",
          { outcome: "succeeded" },
        )
      ).statusCode,
    ).toBe(404);
  } finally {
    await f.close();
  }
});
test("worker checks binding and applies verified admission only once across restarts", async () => {
  let bad = true;
  const adapter: MidnightAdapter = {
    ...trustedAdapter,
    async verify(i) {
      return {
        status: "succeeded",
        bindingHash: bad ? "wrong" : i.bindingHash,
        network: i.network,
        contractAddress: i.contractAddress,
        purpose: i.purpose,
        evidenceRef: "evidence",
      };
    },
  };
  const f = await fixture("real", { midnight: adapter });
  try {
    const u = await user(f);
    await issuedTicket(f, u);
    const i = (
      await call(f, u, "POST", "/events/evt/chain-intents", admission)
    ).json().data;
    expect(i?.id).toBeTruthy();
    await call(f, u, "POST", `/events/evt/chain-intents/${i.id}/transactions`, {
      transactionId: "tx",
    });
    await reconcile(f.pool, adapter);
    expect(
      (await call(f, u, "GET", "/me")).json().data.admissionStatus,
    ).not.toBe("active");
    const op = await call(
      f,
      u,
      "GET",
      `/events/evt/operations/${i.operationId}`,
    );
    expect(op.json().data.failureCode).toBe("INVALID_BINDING");
    bad = false;
    const next = (
      await call(f, u, "POST", "/events/evt/chain-intents", admission)
    ).json().data;
    await call(
      f,
      u,
      "POST",
      `/events/evt/chain-intents/${next.id}/transactions`,
      { transactionId: "tx2" },
    );
    await reconcile(f.pool, adapter);
    await reconcile(f.pool, adapter);
    expect((await call(f, u, "GET", "/me")).json().data.admissionStatus).toBe(
      "active",
    );
    expect(
      (await f.pool.query("SELECT * FROM processed_effects")).rowCount,
    ).toBe(1);
  } finally {
    await f.close();
  }
});
test("adapter preparation failure returns an unavailable state without committing admission", async () => {
  const f = await fixture("real", {
    midnight: {
      ...trustedAdapter,
      async prepare() {
        throw new Error("private provider error");
      },
    },
  });
  try {
    const a = await user(f);
    await issuedTicket(f, a);
    const r = await call(f, a, "POST", "/events/evt/chain-intents", admission);
    expect(r.statusCode).toBe(503);
    expect(r.body).not.toContain("private provider error");
    expect(
      (await f.pool.query("SELECT * FROM chain_intents")).rows,
    ).toHaveLength(0);
  } finally {
    await f.close();
  }
});
