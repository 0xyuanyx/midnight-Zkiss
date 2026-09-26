/** Explicit demo smoke. Synthetic pixels only; no real users, secrets or contact data. */
import sharp from "sharp";
import { randomUUID, randomBytes } from "node:crypto";
const base = process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:3001";
const event = process.env.SMOKE_EVENT_ID ?? "evt_mvp";
const E = `/events/${event}`;
type User = { cookie: string; csrf: string; id: string };
async function request(path: string, method = "GET", body?: unknown, u?: User) {
  const response = await fetch(base + "/api/v1" + path, {
    method,
    headers: {
      ...(u ? { cookie: u.cookie, "X-CSRF-Token": u.csrf } : {}),
      "Idempotency-Key": randomUUID(),
      ...(body instanceof FormData
        ? {}
        : { "Content-Type": "application/json" }),
    },
    body:
      body instanceof FormData
        ? body
        : body === undefined
          ? undefined
          : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status}`);
  return {
    data: response.status === 204 ? null : (await response.json()).data,
    cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "",
  };
}
try {
  if ((await request(E)).data.mode !== "demo") throw new Error("DEMO_ONLY");
  const onboard = async (name: string) => {
    const s = await request("/sessions", "POST", { eventId: event, devicePublicKey: Buffer.alloc(32, 1).toString("base64") });
    const u = {
      id: s.data.participantId,
      cookie: s.cookie,
      csrf: s.data.csrfToken,
    };
    await request(
      E + "/me/profile",
      "PUT",
      { expectedVersion: 0, nickname: name, age: 24, gender: "unspecified" },
      u,
    );
    const form = new FormData();
    form.set("expectedVersion", "1");
    form.set(
      "photo",
      new Blob(
        [
          new Uint8Array(
            await sharp({
              create: {
                width: 2,
                height: 2,
                channels: 3,
                background: "#888888",
              },
            })
              .png()
              .toBuffer(),
          ),
        ],
        { type: "image/png" },
      ),
      "synthetic.png",
    );
    let ai = (await request(E + "/me/ai-jobs", "POST", form, u)).data;
    while (ai.status === "processing") {
      await new Promise((resolve) => setTimeout(resolve, 100));
      ai = (await request(E + "/me/ai-jobs/" + ai.id, "GET", undefined, u))
        .data;
    }
    if (ai.status !== "succeeded") throw new Error("AI_FAILED");
    if (s.data.admissionStatus !== 'active') {
    await request(
      E + "/midnight/ticket",
      "POST",
      { ticketLeaf: randomBytes(32).toString("hex") },
      u,
    );
    let issued = false;
    for (let n = 0; n < 120; n++) {
      if (
        (await request("/me", "GET", undefined, u)).data.ticket.status ===
        "issued"
      ) {
        issued = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!issued) throw new Error("TICKET_WORKER_REQUIRED");
    const intent = (
      await request(
        E + "/chain-intents",
        "POST",
        {
          purpose: "admission",
          devicePublicKey: Buffer.alloc(32, 1).toString("base64"),
          deviceKeyVersion: 1,
        },
        u,
      )
    ).data;
    await request(
      E + `/demo/chain-intents/${intent.id}/resolution`,
      "POST",
      { outcome: "succeeded" },
      u,
    );
    }
    await request(
      E + "/me/profile/publication",
      "POST",
      { expectedVersion: ai.profileVersion },
      u,
    );
    return u;
  };
  const a = await onboard("Demo A"),
    b = await onboard("Demo B");
  await request(E + "/likes", "POST", { targetProfileId: b.id }, a);
  const match = (
    await request(E + "/likes", "POST", { targetProfileId: a.id }, b)
  ).data;
  const room = E + `/conversations/${match.conversationId}`;
  await request(
    room + "/messages",
    "POST",
    { clientMessageId: randomUUID(), text: "Synthetic smoke message" },
    a,
  );
  const messages = (await request(room + "/messages", "GET", undefined, b))
    .data;
  if (messages.items.length !== 1 || messages.items[0].sender !== "peer")
    throw new Error("MESSAGE_MISSING");
  const encrypted = {
    suite: "hpke-x25519-hkdfsha256-aes128gcm-v1",
    enc: Buffer.alloc(32, 7).toString("base64"),
    ciphertext: Buffer.alloc(112, 8).toString("base64"),
    contextHash: "0".repeat(64),
    recipientKeyVersion: 1,
  };
  for (const u of [a, b])
    await request(
      E + "/me/contact-vault",
      "PUT",
      {
        expectedVersion: 0,
        commitment: randomBytes(32).toString("hex"),
        ownerEnvelope: encrypted,
      },
      u,
    );
  let reveal = (
    await request(
      room + "/reveal-requests",
      "POST",
      { expectedVersion: 1, ownContactVersion: 1, consent: true },
      a,
    )
  ).data;
  const revealPath = E + "/reveal-requests/" + reveal.id;
  for (const u of [a, b])
    await request(
      revealPath + "/room-material",
      "PUT",
      {
        slot: randomBytes(32).toString("hex"),
        roomPublicKey: randomBytes(32).toString("base64"),
        keyCommit: randomBytes(32).toString("hex"),
        contactCommit: randomBytes(32).toString("hex"),
      },
      u,
    );
  for (let n = 0; n < 120; n++) {
    reveal = (await request(revealPath, "GET", undefined, a)).data;
    if (reveal.status !== "collecting") break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (reveal.status !== "requested") throw new Error("TERMS_WORKER_REQUIRED");
  await request(
    revealPath + "/decisions",
    "POST",
    {
      expectedVersion: reveal.version,
      transcriptHash: reveal.transcriptHash,
      action: "accept",
    },
    b,
  );
  for (const u of [a, b]) {
    const intent = (
      await request(
        E + "/chain-intents",
        "POST",
        {
          purpose: "reveal_approval",
          revealRequestId: reveal.id,
          transcriptHash: reveal.transcriptHash,
        },
        u,
      )
    ).data;
    await request(
      E + "/demo/chain-intents/" + intent.id + "/resolution",
      "POST",
      { outcome: "succeeded" },
      u,
    );
  }
  for (const u of [a, b]) {
    reveal = (await request(revealPath, "GET", undefined, u)).data;
    await request(
      revealPath + "/my-envelope",
      "PUT",
      {
        expectedVersion: reveal.version,
        transcriptHash: reveal.transcriptHash,
        envelope: { ...encrypted, contextHash: reveal.transcriptHash },
      },
      u,
    );
  }
  await request(revealPath + "/peer-envelope", "GET", undefined, a);
  await request(revealPath + "/peer-envelope", "GET", undefined, b);
  await request(room + "/leave", "POST", { expectedVersion: 1 }, a);
  console.log(
    "DEMO_SMOKE_PASS: two sessions, synthetic AI, simulated ticket/admission, published profiles, mutual match, chat, room material/terms, two approvals/envelopes, release, leave.",
  );
} catch (e) {
  console.error(e instanceof Error ? e.message : "SMOKE_FAILED");
  process.exitCode = 1;
}
