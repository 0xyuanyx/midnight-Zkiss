import { test, expect } from "vitest";
import { fixture, activeUser, call } from "./helpers.js";
test("received likes expose only active public profiles and mark mutual state", async () => {
  const f = await fixture();
  try {
    const a = await activeUser(f, "A"), b = await activeUser(f, "B"), c = await activeUser(f, "C");
    await call(f, b, "POST", "/events/evt/likes", { targetProfileId: a.id });
    await call(f, c, "POST", "/events/evt/likes", { targetProfileId: a.id });
    let received = await call(f, a, "GET", "/events/evt/me/likes?direction=received");
    expect(received.statusCode).toBe(200);
    expect(received.json().data.items.map((item: { source: { nickname: string }; state: string }) => [item.source.nickname, item.state]).sort()).toEqual([["B", "received"], ["C", "received"]]);
    await call(f, a, "POST", "/events/evt/likes", { targetProfileId: b.id });
    await f.pool.query("UPDATE participants SET profile_status='hidden' WHERE id=$1", [c.id]);
    received = await call(f, a, "GET", "/events/evt/me/likes?direction=received");
    expect(received.json().data.items.map((item: { source: { nickname: string }; state: string }) => [item.source.nickname, item.state])).toEqual([["B", "matched"]]);
  } finally { await f.close(); }
});
test("simultaneous mutual likes create exactly one room and retries cannot duplicate it", async () => {
  const f = await fixture();
  try {
    const a = await activeUser(f, "A"),
      b = await activeUser(f, "B");
    const replies = await Promise.all([
      call(
        f,
        a,
        "POST",
        "/events/evt/likes",
        { targetProfileId: b.id },
        "like-a",
      ),
      call(
        f,
        b,
        "POST",
        "/events/evt/likes",
        { targetProfileId: a.id },
        "like-b",
      ),
    ]);
    expect(replies.map((r) => r.statusCode)).toEqual([200, 200]);
    expect(replies.map((r) => r.json().data.state).sort()).toEqual([
      "matched",
      "sent",
    ]);
    expect((await f.pool.query("SELECT * FROM conversations")).rowCount).toBe(
      1,
    );
    expect(
      (
        await call(
          f,
          a,
          "POST",
          "/events/evt/likes",
          { targetProfileId: b.id },
          "like-a",
        )
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await call(
          f,
          a,
          "POST",
          "/events/evt/likes",
          { targetProfileId: a.id },
          "like-a",
        )
      ).statusCode,
    ).toBe(409);
    const rooms = await call(f, a, "GET", "/events/evt/conversations");
    expect(rooms.json().data.items).toHaveLength(1);
  } finally {
    await f.close();
  }
});
test("anonymous answers hide responder identity and first reply atomically creates two messages", async () => {
  const f = await fixture();
  try {
    const a = await activeUser(f, "questioner"),
      b = await activeUser(f, "SECRET-NICK");
    const q = await call(f, a, "PUT", "/events/evt/me/question", {
      expectedVersion: 0,
      body: "어떤 음악을 좋아해요?",
    });
    expect(q.statusCode).toBe(200);
    const ans = await call(
      f,
      b,
      "POST",
      `/events/evt/questions/${q.json().data.id}/answers`,
      { expectedQuestionVersion: 1, body: "재즈요" },
    );
    expect(ans.statusCode).toBe(201);
    expect(
      (await call(f, b, "GET", "/events/evt/conversations")).json().data.items,
    ).toEqual([]);
    const received = await call(
      f,
      a,
      "GET",
      "/events/evt/me/answers?direction=received",
    );
    expect(received.statusCode).toBe(200);
    expect(received.body).not.toContain(b.id);
    expect(received.body).not.toContain("SECRET-NICK");
    const answerId = ans.json().data.id;
    const decisions = await Promise.all([
      call(
        f,
        a,
        "POST",
        `/events/evt/answers/${answerId}/decision`,
        { action: "accept", reply: "저도요", expectedVersion: 1 },
        "accept",
      ),
      call(
        f,
        a,
        "POST",
        `/events/evt/answers/${answerId}/decision`,
        { action: "accept", reply: "저도요", expectedVersion: 1 },
        "accept",
      ),
    ]);
    expect(decisions.map((r) => r.statusCode)).toEqual([200, 200]);
    expect(decisions[0].json().data.conversation.peer.identity).toBe(
      "anonymous",
    );
    expect((await f.pool.query("SELECT * FROM conversations")).rowCount).toBe(
      1,
    );
    expect((await f.pool.query("SELECT * FROM messages")).rowCount).toBe(2);
  } finally {
    await f.close();
  }
});
test("messages are member-only, retry-safe, ordered, and prohibited after leave", async () => {
  const f = await fixture();
  try {
    const a = await activeUser(f),
      b = await activeUser(f),
      stranger = await activeUser(f);
    await call(f, a, "POST", "/events/evt/likes", { targetProfileId: b.id });
    const match = await call(f, b, "POST", "/events/evt/likes", {
      targetProfileId: a.id,
    });
    expect(match.statusCode).toBe(200);
    const room = match.json().data.conversationId;
    expect(
      (
        await call(
          f,
          stranger,
          "GET",
          `/events/evt/conversations/${room}/messages`,
        )
      ).statusCode,
    ).toBe(404);
    const path = `/events/evt/conversations/${room}/messages`;
    const r = await call(f, a, "POST", path, {
      clientMessageId: "client-1",
      text: "안녕하세요",
    });
    expect(r.statusCode).toBe(201);
    const retry = await call(f, a, "POST", path, {
      clientMessageId: "client-1",
      text: "안녕하세요",
    });
    expect(retry.json().data.id).toBe(r.json().data.id);
    expect(
      (
        await call(f, a, "POST", path, {
          clientMessageId: "client-1",
          text: "changed",
        })
      ).statusCode,
    ).toBe(409);
    const messages = await call(f, b, "GET", path);
    expect(
      messages.json().data.items.map((m: any) => [m.sequence, m.sender]),
    ).toEqual([[1, "peer"]]);
    expect(
      (
        await call(f, b, "PUT", `/events/evt/conversations/${room}/read`, {
          throughSequence: 999,
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await call(f, a, "POST", `/events/evt/conversations/${room}/leave`, {
          expectedVersion: 1,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await call(f, b, "POST", path, {
          clientMessageId: "client-2",
          text: "after",
        })
      ).statusCode,
    ).toBe(409);
    expect((await call(f, b, "GET", path)).statusCode).toBe(404);
  } finally {
    await f.close();
  }
});
test("disabled modes, cross-event targets and contextual blocking are enforced on writes", async () => {
  const f = await fixture();
  try {
    const a = await activeUser(f),
      b = await activeUser(f),
      other = await activeUser(f, "else", "other");
    expect(
      (
        await call(f, a, "POST", "/events/evt/likes", {
          targetProfileId: other.id,
        })
      ).statusCode,
    ).toBe(404);
    const blocked = await call(f, a, "POST", "/events/evt/blocks", {
      contextType: "profile",
      contextId: b.id,
    });
    expect(blocked.statusCode).toBe(204);
    expect(
      (await call(f, b, "POST", "/events/evt/likes", { targetProfileId: a.id }))
        .statusCode,
    ).toBe(404);
    await f.pool.query("UPDATE events SET modes='[]' WHERE id='evt'");
    expect(
      (await call(f, a, "POST", "/events/evt/likes", { targetProfileId: b.id }))
        .statusCode,
    ).toBe(409);
  } finally {
    await f.close();
  }
});
