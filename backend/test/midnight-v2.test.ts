import { test, expect } from "vitest";
import { fixture, user, activeUser, call } from "./helpers.js";
const admission = {
  purpose: "admission",
  devicePublicKey: Buffer.alloc(32, 1).toString("base64"),
  deviceKeyVersion: 1,
};
test("admission waits for issued ticket and ticket leaf cannot be replaced", async () => {
  const f = await fixture();
  try {
    const u = await user(f);
    expect(
      (await call(f, u, "POST", "/events/evt/chain-intents", admission))
        .statusCode,
    ).toBe(409);
    const t = await call(f, u, "POST", "/events/evt/midnight/ticket", {
      ticketLeaf: "1".repeat(64),
    });
    expect(t.statusCode).toBe(202);
    expect(t.json().data.status).toBe("issuing");
    expect(
      (
        await call(f, u, "POST", "/events/evt/midnight/ticket", {
          ticketLeaf: "2".repeat(64),
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (await call(f, u, "POST", "/events/evt/chain-intents", admission))
        .statusCode,
    ).toBe(409);
  } finally {
    await f.close();
  }
});
test("reveal creation collects client material without inventing transcript or keys", async () => {
  const f = await fixture();
  try {
    const a = await activeUser(f),
      b = await activeUser(f);
    await call(f, a, "POST", "/events/evt/likes", { targetProfileId: b.id });
    const m = (
      await call(f, b, "POST", "/events/evt/likes", { targetProfileId: a.id })
    ).json().data;
    await f.pool.query(
      "UPDATE participants SET contact='{}',contact_version=1 WHERE id=ANY($1::text[])",
      [[a.id, b.id]],
    );
    const r = await call(
      f,
      a,
      "POST",
      `/events/evt/conversations/${m.conversationId}/reveal-requests`,
      { expectedVersion: 1, ownContactVersion: 1, consent: true },
    );
    expect(r.statusCode).toBe(201);
    expect(r.json().data.status).toBe("collecting");
    expect(r.json().data.transcriptHash).toBeNull();
    expect(r.json().data.chainRoomId).toMatch(/^[a-f0-9]{64}$/);
  } finally {
    await f.close();
  }
});

import {
  demoMidnight,
  createDemoOperator,
} from "../src/adapters/demo-midnight.js";
import * as worker from "../src/worker.js";
async function run(f: any, op: any, adapter: any = demoMidnight) {
  expect(typeof (worker as any).processChainJobs).toBe("function");
  await (worker as any).processChainJobs(f.pool, adapter, op);
}
async function collecting(f: any) {
  const a = await activeUser(f),
    b = await activeUser(f);
  await call(f, a, "POST", "/events/evt/likes", { targetProfileId: b.id });
  const room = (
    await call(f, b, "POST", "/events/evt/likes", { targetProfileId: a.id })
  ).json().data.conversationId;
  await f.pool.query(
    "UPDATE participants SET contact='{}',contact_version=1 WHERE id=ANY($1::text[])",
    [[a.id, b.id]],
  );
  const r = (
    await call(
      f,
      a,
      "POST",
      `/events/evt/conversations/${room}/reveal-requests`,
      { expectedVersion: 1, ownContactVersion: 1, consent: true },
    )
  ).json().data;
  return { a, b, room, r };
}
const material = (n: number) => ({
  slot: String(n).repeat(64),
  roomPublicKey: Buffer.alloc(32, n).toString("base64"),
  keyCommit: "c".repeat(64),
  contactCommit: String(n + 2).repeat(64),
});
async function upload(f: any, u: any, r: any, n: number) {
  return call(
    f,
    u,
    "PUT",
    `/events/evt/reveal-requests/${r.id}/room-material`,
    material(n),
  );
}
test("ticket worker recovers lost response using effect readback and emits issued state", async () => {
  const f = await fixture();
  const base = createDemoOperator();
  let calls = 0;
  const op = {
    ...base,
    async issueTicket(...args: Parameters<typeof base.issueTicket>) {
      calls++;
      await base.issueTicket(...args);
      throw new Error("lost response");
    },
  };
  try {
    const u = await user(f);
    await call(f, u, "POST", "/events/evt/midnight/ticket", {
      ticketLeaf: "1".repeat(64),
    });
    await run(f, op);
    await f.pool.query("UPDATE chain_jobs SET next_attempt_at=now()");
    await run(f, op);
    expect(calls).toBe(1);
    expect((await call(f, u, "GET", "/me")).json().data.ticket.status).toBe(
      "issued",
    );
    expect(
      (await call(f, u, "POST", "/events/evt/chain-intents", admission))
        .statusCode,
    ).toBe(201);
    expect(
      (await f.pool.query("SELECT kind FROM outbox WHERE audience=$1", [u.id]))
        .rows,
    ).toContainEqual({ kind: "ticket.status_changed" });
  } finally {
    await f.close();
  }
});
test("material is private and immutable; adapter owns transcript and terms; slots stay fixed across requests", async () => {
  const f = await fixture();
  const op = createDemoOperator();
  const adapter = {
    ...demoMidnight,
    async revealTerms(input: any) {
      expect([...input.slots].sort()).toEqual(["1".repeat(64), "2".repeat(64)]);
      expect([...input.contactCommits].sort()).toEqual([
        "3".repeat(64),
        "4".repeat(64),
      ]);
      expect(input.expiresAt).toMatch(/\.000Z$/);
      return { transcriptHash: "f".repeat(64), terms: "Y2xhdWRlLXRlcm1z" };
    },
  };
  try {
    const { a, b, room, r } = await collecting(f);
    const stranger = await activeUser(f);
    expect((await upload(f, stranger, r, 1)).statusCode).toBe(404);
    expect((await upload(f, a, r, 1)).statusCode).toBe(200);
    expect((await upload(f, a, r, 1)).statusCode).toBe(200);
    expect((await upload(f, a, r, 2)).statusCode).toBe(409);
    expect((await upload(f, b, r, 2)).statusCode).toBe(200);
    await run(f, op, adapter);
    let current = (
      await call(f, a, "GET", `/events/evt/reveal-requests/${r.id}`)
    ).json().data;
    expect(current.status).toBe("requested");
    expect(current.transcriptHash).toBe("f".repeat(64));
    expect(current.terms).toBe("Y2xhdWRlLXRlcm1z");
    await call(f, a, "POST", `/events/evt/reveal-requests/${r.id}/decisions`, {
      expectedVersion: current.version,
      transcriptHash: current.transcriptHash,
      action: "cancel",
    });
    const next = (
      await call(
        f,
        a,
        "POST",
        `/events/evt/conversations/${room}/reveal-requests`,
        { expectedVersion: 1, ownContactVersion: 1, consent: true },
      )
    ).json().data;
    expect(next.chainRoomId).toBe(r.chainRoomId);
    expect((await upload(f, a, next, 2)).statusCode).toBe(409);
  } finally {
    await f.close();
  }
});
test("leaving during slow open is immediate and worker closes late-opened room without publishing terms", async () => {
  const f = await fixture();
  const base = createDemoOperator();
  let entered!: () => void, finish!: () => void;
  const started = new Promise<void>((r) => (entered = r)),
    gate = new Promise<void>((r) => (finish = r));
  const op = {
    ...base,
    async openRoom(...args: Parameters<typeof base.openRoom>) {
      entered();
      await gate;
      return base.openRoom(...args);
    },
  };
  let pending: Promise<any> | undefined;
  try {
    const { a, b, room, r } = await collecting(f);
    await upload(f, a, r, 1);
    await upload(f, b, r, 2);
    expect(typeof (worker as any).processChainJobs).toBe("function");
    pending = (worker as any).processChainJobs(f.pool, demoMidnight, op);
    await started;
    expect(
      (
        await call(f, a, "POST", `/events/evt/conversations/${room}/leave`, {
          expectedVersion: 1,
        })
      ).statusCode,
    ).toBe(200);
    finish();
    await pending;
    await run(f, op);
    expect(
      (await call(f, b, "GET", `/events/evt/reveal-requests/${r.id}`)).json()
        .data.status,
    ).toBe("cancelled");
    expect(
      await base.roomState(
        {
          network: r.network,
          contractAddress: r.contractAddress,
          eventScope: r.eventScope,
        },
        r.chainRoomId,
      ),
    ).toBe("closed");
  } finally {
    finish?.();
    await pending;
    await f.close();
  }
});

const envelope = {
  suite: "hpke-x25519-hkdfsha256-aes128gcm-v1",
  enc: Buffer.alloc(32, 9).toString("base64"),
  ciphertext: Buffer.alloc(112, 8).toString("base64"),
  recipientKeyVersion: 1,
};
async function authorized(f: any, adapter: any, op: any) {
  const pair = await collecting(f);
  const { a, b, r } = pair;
  await upload(f, a, r, 1);
  await upload(f, b, r, 2);
  await run(f, op, adapter);
  let current = (
    await call(f, a, "GET", `/events/evt/reveal-requests/${r.id}`)
  ).json().data;
  const accept = await call(
    f,
    b,
    "POST",
    `/events/evt/reveal-requests/${r.id}/decisions`,
    {
      expectedVersion: current.version,
      transcriptHash: current.transcriptHash,
      action: "accept",
    },
  );
  expect(accept.statusCode).toBe(200);
  for (const u of [a, b]) {
    const i = await call(f, u, "POST", "/events/evt/chain-intents", {
      purpose: "reveal_approval",
      revealRequestId: r.id,
      transcriptHash: current.transcriptHash,
    });
    expect(i.statusCode).toBe(201);
    await call(
      f,
      u,
      "POST",
      `/events/evt/demo/chain-intents/${i.json().data.id}/resolution`,
      { outcome: "succeeded" },
    );
  }
  return pair;
}
test("fresh chain readback gates both envelopes and unavailable readback recovers through worker", async () => {
  let chain: "unknown" | "authorized" | "closed" = "unknown";
  let down = true;
  const adapter = {
    ...demoMidnight,
    async revealStatus() {
      if (down) throw new Error("readback unavailable");
      return chain;
    },
  };
  const op = createDemoOperator();
  const f = await fixture("demo", { midnight: adapter });
  try {
    const { a, b, r } = await authorized(f, adapter, op);
    for (const u of [a, b]) {
      const current = (
        await call(f, u, "GET", `/events/evt/reveal-requests/${r.id}`)
      ).json().data;
      expect(
        (
          await call(
            f,
            u,
            "PUT",
            `/events/evt/reveal-requests/${r.id}/my-envelope`,
            {
              expectedVersion: current.version,
              transcriptHash: current.transcriptHash,
              envelope: { ...envelope, contextHash: current.transcriptHash },
            },
          )
        ).statusCode,
      ).toBe(200);
    }
    expect(
      (
        await call(
          f,
          a,
          "GET",
          `/events/evt/reveal-requests/${r.id}/peer-envelope`,
        )
      ).statusCode,
    ).toBe(409);
    down = false;
    await run(f, op, adapter);
    expect(
      (
        await call(
          f,
          b,
          "GET",
          `/events/evt/reveal-requests/${r.id}/peer-envelope`,
        )
      ).statusCode,
    ).toBe(409);
    chain = "authorized";
    await run(f, op, adapter);
    expect(
      (
        await call(
          f,
          a,
          "GET",
          `/events/evt/reveal-requests/${r.id}/peer-envelope`,
        )
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await call(
          f,
          b,
          "GET",
          `/events/evt/reveal-requests/${r.id}/peer-envelope`,
        )
      ).statusCode,
    ).toBe(200);
  } finally {
    await f.close();
  }
});
test("closed chain state prevents release even when both approvals verified", async () => {
  const adapter = {
    ...demoMidnight,
    async revealStatus() {
      return "closed" as const;
    },
  };
  const op = createDemoOperator();
  const f = await fixture("demo", { midnight: adapter });
  try {
    const { a, b, r } = await authorized(f, adapter, op);
    for (const u of [a, b]) {
      const current = (
        await call(f, u, "GET", `/events/evt/reveal-requests/${r.id}`)
      ).json().data;
      await call(
        f,
        u,
        "PUT",
        `/events/evt/reveal-requests/${r.id}/my-envelope`,
        {
          expectedVersion: current.version,
          transcriptHash: current.transcriptHash,
          envelope: { ...envelope, contextHash: current.transcriptHash },
        },
      );
    }
    expect(
      (await call(f, a, "GET", `/events/evt/reveal-requests/${r.id}`)).json()
        .data.status,
    ).toBe("cancelled");
    expect(
      (
        await call(
          f,
          a,
          "GET",
          `/events/evt/reveal-requests/${r.id}/peer-envelope`,
        )
      ).statusCode,
    ).toBe(409);
  } finally {
    await f.close();
  }
});
test("ticket replay returns current issued state and cannot authorize a different deployment", async () => {
  const f = await fixture();
  const op = createDemoOperator();
  try {
    const u = await user(f);
    const body = { ticketLeaf: "1".repeat(64) };
    expect(
      (await call(f, u, "POST", "/events/evt/midnight/ticket", body, "ticket"))
        .statusCode,
    ).toBe(202);
    await run(f, op);
    expect(
      (
        await call(f, u, "POST", "/events/evt/midnight/ticket", body, "ticket")
      ).json().data.status,
    ).toBe("issued");
    await f.pool.query(
      "UPDATE events SET midnight_contract_address=$1 WHERE id='evt'",
      ["d".repeat(64)],
    );
    expect(
      (await call(f, u, "POST", "/events/evt/chain-intents", admission))
        .statusCode,
    ).toBe(409);
  } finally {
    await f.close();
  }
});
test("suspension queues chain closure and close retries read back a lost successful response", async () => {
  const f = await fixture();
  const base = createDemoOperator();
  let closes = 0;
  const op = {
    ...base,
    async closeRoom(...args: Parameters<typeof base.closeRoom>) {
      closes++;
      await base.closeRoom(...args);
      throw new Error("lost");
    },
  };
  try {
    const { a, b, r } = await collecting(f);
    await upload(f, a, r, 1);
    await upload(f, b, r, 2);
    await run(f, op);
    await f.pool.query(
      "UPDATE participants SET admission_status='suspended' WHERE id=$1",
      [a.id],
    );
    await run(f, op);
    await f.pool.query("UPDATE chain_jobs SET next_attempt_at=now()");
    await run(f, op);
    expect(closes).toBe(1);
    expect(
      (await f.pool.query("SELECT status FROM chain_jobs WHERE kind='close'"))
        .rows,
    ).toEqual([{ status: "done" }]);
    expect(
      (await call(f, b, "GET", `/events/evt/reveal-requests/${r.id}`)).json()
        .data.status,
    ).toBe("cancelled");
  } finally {
    await f.close();
  }
});

test("late successful admission on an old deployment cannot activate the reconfigured event", async () => {
  const f = await fixture();
  const op = createDemoOperator();
  try {
    const u = await user(f);
    await call(f, u, "POST", "/events/evt/midnight/ticket", {
      ticketLeaf: "1".repeat(64),
    });
    await run(f, op);
    const i = (
      await call(f, u, "POST", "/events/evt/chain-intents", admission)
    ).json().data;
    await f.pool.query(
      "UPDATE events SET midnight_event_scope=$1 WHERE id='evt'",
      ["e".repeat(64)],
    );
    const done = await call(
      f,
      u,
      "POST",
      `/events/evt/demo/chain-intents/${i.id}/resolution`,
      { outcome: "succeeded" },
    );
    expect(done.json().data.effectApplied).toBe(false);
    expect(
      (await call(f, u, "GET", "/me")).json().data.admissionStatus,
    ).not.toBe("active");
  } finally {
    await f.close();
  }
});
import { vi } from "vitest";
test("consent expiring during final readback never releases ciphertext", async () => {
  const adapter = {
    ...demoMidnight,
    async revealStatus() {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() + 11 * 60 * 1000);
      return "authorized" as const;
    },
  };
  const op = createDemoOperator();
  const f = await fixture("demo", { midnight: adapter });
  try {
    const { a, b, r } = await authorized(f, adapter, op);
    for (const u of [a, b]) {
      const current = (
        await call(f, u, "GET", `/events/evt/reveal-requests/${r.id}`)
      ).json().data;
      const uploaded = await call(
        f,
        u,
        "PUT",
        `/events/evt/reveal-requests/${r.id}/my-envelope`,
        {
          expectedVersion: current.version,
          transcriptHash: current.transcriptHash,
          envelope: { ...envelope, contextHash: current.transcriptHash },
        },
      );
      expect(uploaded.statusCode).toBe(200);
    }
    expect(
      (
        await call(
          f,
          a,
          "GET",
          `/events/evt/reveal-requests/${r.id}/peer-envelope`,
        )
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await f.pool.query("SELECT status FROM reveal_requests WHERE id=$1", [
          r.id,
        ])
      ).rows[0].status,
    ).toBe("expired");
  } finally {
    vi.useRealTimers();
    await f.close();
  }
});

test("ticket queued before event closure settles as failed instead of waiting forever", async () => {
  const f = await fixture();
  const op = createDemoOperator();
  try {
    const u = await user(f);
    await call(f, u, "POST", "/events/evt/midnight/ticket", {
      ticketLeaf: "1".repeat(64),
    });
    await f.pool.query("UPDATE events SET status='closed' WHERE id='evt'");
    await run(f, op);
    expect((await call(f, u, "GET", "/me")).json().data.ticket.status).toBe(
      "failed",
    );
    expect(
      (await f.pool.query("SELECT status FROM chain_jobs WHERE kind='ticket'"))
        .rows,
    ).toEqual([{ status: "done" }]);
  } finally {
    await f.close();
  }
});
