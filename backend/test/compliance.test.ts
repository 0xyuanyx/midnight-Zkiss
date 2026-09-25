import { test, expect } from "vitest";
import { fixture, activeUser, call, user } from "./helpers.js";
test("draft edits remain private until explicit publication", async () => {
  const f = await fixture();
  try {
    const a = await activeUser(f, "Original"),
      b = await activeUser(f, "Reader");
    await call(f, a, "PUT", "/events/evt/me/profile", {
      expectedVersion: 1,
      nickname: "Private edit",
      age: 26,
      gender: "unspecified",
    });
    const res = await call(f, b, "GET", `/events/evt/profiles/${a.id}`);
    expect(res.json().data.nickname).toBe("Original");
    expect(res.body).not.toContain("Private edit");
  } finally {
    await f.close();
  }
});
test("suspended participants cannot restart admission through onboarding routes", async () => {
  const f = await fixture();
  try {
    const a = await user(f);
    await f.pool.query(
      "UPDATE participants SET admission_status='suspended' WHERE id=$1",
      [a.id],
    );
    const r = await call(f, a, "POST", "/events/evt/chain-intents", {
      purpose: "admission",
      devicePublicKey: Buffer.alloc(32, 1).toString("base64"),
      deviceKeyVersion: 1,
    });
    expect(r.statusCode).toBe(403);
  } finally {
    await f.close();
  }
});
test("feed supports actionable question filter and no duplicate answer action", async () => {
  const f = await fixture();
  try {
    const a = await activeUser(f, "A"),
      b = await activeUser(f, "B");
    await activeUser(f, "No question");
    const q = (
      await call(f, b, "PUT", "/events/evt/me/question", {
        expectedVersion: 0,
        body: "질문",
      })
    ).json().data;
    let r = await call(f, a, "GET", "/events/evt/feed?filter=open_to_answers");
    expect(r.statusCode).toBe(200);
    expect(r.json().data.items).toHaveLength(1);
    expect(r.json().data.items[0].allowedActions).toContain("answer");
    await call(f, a, "POST", `/events/evt/questions/${q.id}/answers`, {
      expectedQuestionVersion: 1,
      body: "답변",
    });
    r = await call(f, a, "GET", "/events/evt/feed?filter=open_to_answers");
    expect(r.json().data.items).toHaveLength(0);
  } finally {
    await f.close();
  }
});
test("real event does not advertise reveal without a verified adapter", async () => {
  const f = await fixture("real");
  try {
    const r = await f.app.inject("/api/v1/events/evt");
    expect(r.json().data.features.snsReveal).toBe(false);
  } finally {
    await f.close();
  }
});
test("idempotent message replay cannot bypass a closed room", async () => {
  const f = await fixture();
  try {
    const a = await activeUser(f),
      b = await activeUser(f);
    await call(f, a, "POST", "/events/evt/likes", { targetProfileId: b.id });
    const r = (
      await call(f, b, "POST", "/events/evt/likes", { targetProfileId: a.id })
    ).json().data.conversationId;
    const body = { clientMessageId: "old", text: "private" };
    expect(
      (
        await call(
          f,
          a,
          "POST",
          `/events/evt/conversations/${r}/messages`,
          body,
          "same",
        )
      ).statusCode,
    ).toBe(201);
    await call(f, b, "POST", `/events/evt/conversations/${r}/leave`, {
      expectedVersion: 1,
    });
    expect(
      (
        await call(
          f,
          a,
          "POST",
          `/events/evt/conversations/${r}/messages`,
          body,
          "same",
        )
      ).statusCode,
    ).toBe(409);
    expect(
      (await call(f, a, "GET", `/events/evt/conversations/${r}`)).json().data
        .lastMessage,
    ).toBeNull();
  } finally {
    await f.close();
  }
});
test("cross-origin session creation is rejected", async () => {
  const f = await fixture();
  try {
    const r = await f.app.inject({
      method: "POST",
      url: "/api/v1/sessions",
      headers: { origin: "https://attacker.invalid" },
      payload: { eventId: "evt" },
    });
    expect(r.statusCode).toBe(403);
  } finally {
    await f.close();
  }
});
test("sent likes exclude withdrawn public profiles", async () => {
  const f = await fixture();
  try {
    const a = await activeUser(f),
      b = await activeUser(f);
    await call(f, a, "POST", "/events/evt/likes", { targetProfileId: b.id });
    await f.pool.query(
      "UPDATE participants SET profile_status='hidden' WHERE id=$1",
      [b.id],
    );
    expect(
      (await call(f, a, "GET", "/events/evt/me/likes")).json().data.items,
    ).toHaveLength(0);
  } finally {
    await f.close();
  }
});
test("accepted-answer replay respects closed room authority", async () => {
  const f = await fixture();
  try {
    const a = await activeUser(f),
      b = await activeUser(f);
    const q = (
      await call(f, a, "PUT", "/events/evt/me/question", {
        expectedVersion: 0,
        body: "Question",
      })
    ).json().data;
    const answer = (
      await call(f, b, "POST", `/events/evt/questions/${q.id}/answers`, {
        expectedQuestionVersion: 1,
        body: "Answer",
      })
    ).json().data;
    const body = {
      expectedVersion: 1,
      action: "accept",
      reply: "Secret reply",
    };
    const first = await call(
      f,
      a,
      "POST",
      `/events/evt/answers/${answer.id}/decision`,
      body,
      "accept-once",
    );
    const room = first.json().data.conversation.id;
    await call(f, a, "POST", `/events/evt/conversations/${room}/leave`, {
      expectedVersion: 1,
    });
    const replay = await call(
      f,
      a,
      "POST",
      `/events/evt/answers/${answer.id}/decision`,
      body,
      "accept-once",
    );
    expect(replay.statusCode).toBe(409);
    expect(replay.body).not.toContain("Secret reply");
  } finally {
    await f.close();
  }
});
test("room recovery DTO exposes deadlines and only available actions", async () => {
  const f = await fixture("real");
  try {
    const a = await activeUser(f),
      b = await activeUser(f);
    await call(f, a, "POST", "/events/evt/likes", { targetProfileId: b.id });
    const id = (
      await call(f, b, "POST", "/events/evt/likes", { targetProfileId: a.id })
    ).json().data.conversationId;
    const r = (
      await call(f, a, "GET", `/events/evt/conversations/${id}`)
    ).json().data;
    expect(r.allowedActions).not.toContain("request_reveal");
    expect(r.chatUntil).toBeTruthy();
    expect(r.revealRequestId).toBeNull();
    const e = (await f.app.inject("/api/v1/events/evt")).json().data;
    expect(e.participantCount).toBe(2);
    expect(e.availableFilters).toContain("open_to_answers");
  } finally {
    await f.close();
  }
});
