import { test, expect } from "vitest";
import { fixture, activeUser, call, collectMaterials } from "./helpers.js";
const encrypted = {
  suite: "hpke-x25519-hkdfsha256-aes128gcm-v1",
  enc: Buffer.alloc(32, 1).toString("base64"),
  ciphertext: Buffer.alloc(32, 2).toString("base64"),
  contextHash: "0".repeat(64),
  recipientKeyVersion: 1,
};
async function pair(f: Awaited<ReturnType<typeof fixture>>) {
  const a = await activeUser(f, "A"),
    b = await activeUser(f, "B");
  await call(f, a, "POST", "/events/evt/likes", { targetProfileId: b.id });
  const m = await call(f, b, "POST", "/events/evt/likes", {
    targetProfileId: a.id,
  });
  for (const u of [a, b]) {
    const r = await call(f, u, "PUT", "/events/evt/me/contact-vault", {
      expectedVersion: 0,
      commitment: "1".repeat(64),
      ownerEnvelope: encrypted,
    });
    expect(r.statusCode).toBe(200);
  }
  return { a, b, room: m.json().data.conversationId };
}
async function approve(
  f: Awaited<ReturnType<typeof fixture>>,
  u: Awaited<ReturnType<typeof activeUser>>,
  r: any,
) {
  const i = await call(f, u, "POST", "/events/evt/chain-intents", {
    purpose: "reveal_approval",
    revealRequestId: r.id,
    transcriptHash: r.transcriptHash,
  });
  expect(i.statusCode).toBe(201);
  expect(
    (
      await call(
        f,
        u,
        "POST",
        `/events/evt/demo/chain-intents/${i.json().data.id}/resolution`,
        { outcome: "succeeded" },
      )
    ).statusCode,
  ).toBe(200);
}
test("both exact-request chain approvals and both envelopes are required before peer access", async () => {
  const f = await fixture();
  try {
    const { a, b, room } = await pair(f);
    const create = await call(
      f,
      a,
      "POST",
      `/events/evt/conversations/${room}/reveal-requests`,
      { expectedVersion: 1, ownContactVersion: 1, consent: true },
    );
    expect(create.statusCode).toBe(201);
    let r = create.json().data;
    expect(
      (
        await f.pool.query(
          "SELECT * FROM outbox WHERE kind='reveal.status_changed' AND resource_id=$1",
          [r.id],
        )
      ).rows,
    ).toHaveLength(2);
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
    r = await collectMaterials(f, a, b, r);
    const accept = await call(
      f,
      b,
      "POST",
      `/events/evt/reveal-requests/${r.id}/decisions`,
      {
        expectedVersion: r.version,
        transcriptHash: r.transcriptHash,
        action: "accept",
      },
    );
    expect(accept.statusCode).toBe(200);
    r = accept.json().data;
    await approve(f, a, r);
    expect(
      (await call(f, a, "GET", `/events/evt/reveal-requests/${r.id}`)).json()
        .data.status,
    ).toBe("awaiting_chain");
    await approve(f, b, r);
    for (const u of [a, b]) {
      r = (
        await call(f, u, "GET", `/events/evt/reveal-requests/${r.id}`)
      ).json().data;
      expect(["authorized", "released"]).toContain(r.status);
      const put = await call(
        f,
        u,
        "PUT",
        `/events/evt/reveal-requests/${r.id}/my-envelope`,
        {
          expectedVersion: r.version,
          transcriptHash: r.transcriptHash,
          envelope: { ...encrypted, contextHash: r.transcriptHash },
        },
      );
      expect(put.statusCode).toBe(200);
      if (u === a)
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
    }
    const peer = await call(
      f,
      a,
      "GET",
      `/events/evt/reveal-requests/${r.id}/peer-envelope`,
    );
    expect(peer.statusCode).toBe(200);
    expect(peer.json().data.ciphertext).toBe(encrypted.ciphertext);
    const stranger = await activeUser(f);
    expect(
      (
        await call(
          f,
          stranger,
          "GET",
          `/events/evt/reveal-requests/${r.id}/peer-envelope`,
        )
      ).statusCode,
    ).toBe(404);
  } finally {
    await f.close();
  }
});
test("leaving or changing contact revokes pending consent; raw SNS fields are rejected", async () => {
  const f = await fixture();
  try {
    const { a, b, room } = await pair(f);
    expect(
      (
        await call(f, a, "PUT", "/events/evt/me/contact-vault", {
          expectedVersion: 1,
          commitment: "2".repeat(64),
          ownerEnvelope: encrypted,
          sns: "plaintext",
        })
      ).statusCode,
    ).toBe(422);
    let r = (
      await call(
        f,
        a,
        "POST",
        `/events/evt/conversations/${room}/reveal-requests`,
        { expectedVersion: 1, ownContactVersion: 1, consent: true },
      )
    ).json().data;
    expect(r?.id).toBeTruthy();
    await call(f, a, "PUT", "/events/evt/me/contact-vault", {
      expectedVersion: 1,
      commitment: "2".repeat(64),
      ownerEnvelope: encrypted,
    });
    expect(
      (await call(f, b, "GET", `/events/evt/reveal-requests/${r.id}`)).json()
        .data.status,
    ).toBe("cancelled");
    r = (
      await call(
        f,
        a,
        "POST",
        `/events/evt/conversations/${room}/reveal-requests`,
        { expectedVersion: 1, ownContactVersion: 2, consent: true },
      )
    ).json().data;
    await call(f, b, "POST", `/events/evt/conversations/${room}/leave`, {
      expectedVersion: 1,
    });
    expect(
      (
        await call(
          f,
          a,
          "GET",
          `/events/evt/reveal-requests/${r.id}/peer-envelope`,
        )
      ).statusCode,
    ).not.toBe(200);
  } finally {
    await f.close();
  }
});
test("late approval after leaving cannot reauthorize a request", async () => {
  const f = await fixture();
  try {
    const { a, b, room } = await pair(f);
    let r = (
      await call(
        f,
        a,
        "POST",
        `/events/evt/conversations/${room}/reveal-requests`,
        { expectedVersion: 1, ownContactVersion: 1, consent: true },
      )
    ).json().data;
    r = await collectMaterials(f, a, b, r);
    r = (
      await call(
        f,
        b,
        "POST",
        `/events/evt/reveal-requests/${r.id}/decisions`,
        {
          expectedVersion: r.version,
          transcriptHash: r.transcriptHash,
          action: "accept",
        },
      )
    ).json().data;
    const i = (
      await call(f, a, "POST", "/events/evt/chain-intents", {
        purpose: "reveal_approval",
        revealRequestId: r.id,
        transcriptHash: r.transcriptHash,
      })
    ).json().data;
    await call(f, b, "POST", `/events/evt/conversations/${room}/leave`, {
      expectedVersion: 1,
    });
    const late = await call(
      f,
      a,
      "POST",
      `/events/evt/demo/chain-intents/${i.id}/resolution`,
      { outcome: "succeeded" },
    );
    expect(late.json().data.effectApplied).toBe(false);
    expect(late.json().data.status).toBe("failed");
    expect(
      (await call(f, a, "GET", `/events/evt/reveal-requests/${r.id}`)).json()
        .data.status,
    ).toBe("cancelled");
  } finally {
    await f.close();
  }
});
test("both approvals must target the same contract deployment", async () => {
  const { demoMidnight } = await import("../src/adapters/demo-midnight.js");
  let network = "demo";
  const adapter = {
    ...demoMidnight,
    async prepare(...args: Parameters<typeof demoMidnight.prepare>) {
      return { ...(await demoMidnight.prepare(...args)), network };
    },
  };
  const f = await fixture("demo", { midnight: adapter });
  try {
    const { a, b, room } = await pair(f);
    let r = (
      await call(
        f,
        a,
        "POST",
        `/events/evt/conversations/${room}/reveal-requests`,
        { expectedVersion: 1, ownContactVersion: 1, consent: true },
      )
    ).json().data;
    r = await collectMaterials(f, a, b, r);
    r = (
      await call(
        f,
        b,
        "POST",
        `/events/evt/reveal-requests/${r.id}/decisions`,
        {
          expectedVersion: r.version,
          transcriptHash: r.transcriptHash,
          action: "accept",
        },
      )
    ).json().data;
    const body = {
      purpose: "reveal_approval",
      revealRequestId: r.id,
      transcriptHash: r.transcriptHash,
    };
    expect(
      (await call(f, a, "POST", "/events/evt/chain-intents", body)).statusCode,
    ).toBe(201);
    network = "two";
    expect(
      (await call(f, b, "POST", "/events/evt/chain-intents", body)).statusCode,
    ).toBe(409);
  } finally {
    await f.close();
  }
});
test("suspension of either peer prevents late approval and final envelope release", async () => {
  const f = await fixture();
  try {
    const { a, b, room } = await pair(f);
    let r = (
      await call(
        f,
        a,
        "POST",
        `/events/evt/conversations/${room}/reveal-requests`,
        { expectedVersion: 1, ownContactVersion: 1, consent: true },
      )
    ).json().data;
    r = await collectMaterials(f, a, b, r);
    r = (
      await call(
        f,
        b,
        "POST",
        `/events/evt/reveal-requests/${r.id}/decisions`,
        {
          expectedVersion: r.version,
          transcriptHash: r.transcriptHash,
          action: "accept",
        },
      )
    ).json().data;
    await approve(f, a, r);
    await approve(f, b, r);
    r = (await call(f, a, "GET", `/events/evt/reveal-requests/${r.id}`)).json()
      .data;
    await call(f, a, "PUT", `/events/evt/reveal-requests/${r.id}/my-envelope`, {
      expectedVersion: r.version,
      transcriptHash: r.transcriptHash,
      envelope: { ...encrypted, contextHash: r.transcriptHash },
    });
    await f.pool.query(
      "UPDATE participants SET admission_status='suspended' WHERE id=$1",
      [a.id],
    );
    r = (await call(f, b, "GET", `/events/evt/reveal-requests/${r.id}`)).json()
      .data;
    const put = await call(
      f,
      b,
      "PUT",
      `/events/evt/reveal-requests/${r.id}/my-envelope`,
      {
        expectedVersion: r.version,
        transcriptHash: r.transcriptHash,
        envelope: { ...encrypted, contextHash: r.transcriptHash },
      },
    );
    expect(put.statusCode).toBe(409);
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
  } finally {
    await f.close();
  }
});
test("worker refuses the other peer approval after a participant is suspended", async () => {
  const f = await fixture();
  try {
    const { a, b, room } = await pair(f);
    let r = (
      await call(
        f,
        a,
        "POST",
        `/events/evt/conversations/${room}/reveal-requests`,
        { expectedVersion: 1, ownContactVersion: 1, consent: true },
      )
    ).json().data;
    r = await collectMaterials(f, a, b, r);
    r = (
      await call(
        f,
        b,
        "POST",
        `/events/evt/reveal-requests/${r.id}/decisions`,
        {
          expectedVersion: r.version,
          transcriptHash: r.transcriptHash,
          action: "accept",
        },
      )
    ).json().data;
    await approve(f, a, r);
    const i = (
      await call(f, b, "POST", "/events/evt/chain-intents", {
        purpose: "reveal_approval",
        revealRequestId: r.id,
        transcriptHash: r.transcriptHash,
      })
    ).json().data;
    await f.pool.query(
      "UPDATE participants SET admission_status='suspended' WHERE id=$1",
      [a.id],
    );
    const op = (
      await call(
        f,
        b,
        "POST",
        `/events/evt/demo/chain-intents/${i.id}/resolution`,
        { outcome: "succeeded" },
      )
    ).json().data;
    expect(op.effectApplied).toBe(false);
    expect(op.status).toBe("failed");
  } finally {
    await f.close();
  }
});
