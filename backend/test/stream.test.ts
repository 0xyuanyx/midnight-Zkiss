import { decodeCursor } from "../src/cursor.js";
import { test, expect } from "vitest";
import { fixture, activeUser, call } from "./helpers.js";
test("SSE replays only recipient events and closes revoked sessions", async () => {
  const f = await fixture();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const abort = new AbortController();
  try {
    const a = await activeUser(f, "A"),
      b = await activeUser(f, "B"),
      other = await activeUser(f, "Other");
    await call(f, a, "POST", "/events/evt/likes", { targetProfileId: b.id });
    const match = await call(f, b, "POST", "/events/evt/likes", {
      targetProfileId: a.id,
    });
    const room = match.json().data.conversationId;
    await call(f, b, "POST", `/events/evt/conversations/${room}/messages`, {
      clientMessageId: "sse",
      text: "secret body",
    });
    const base = await f.app.listen({ host: "127.0.0.1", port: 0 });
    const response = await fetch(
      base + "/api/v1/events/evt/stream?afterEventId=0",
      { headers: { cookie: a.cookie }, signal: abort.signal },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    reader = response.body!.getReader();
    let text = "";
    while (!text.includes("message.created")) {
      text += new TextDecoder().decode((await reader.read()).value);
    }
    expect(text.match(/id: ([^\n]+)/)?.[1]).not.toMatch(/^\d+$/);
    expect(text).toContain("conversation.created");
    expect(text).not.toContain("secret body");
    expect(text).not.toContain(b.id);
    expect(text).not.toContain(other.id);
    await call(f, a, "DELETE", "/sessions/current");
    let done = false;
    for (let i = 0; i < 8 && !done; i++)
      done = (await reader.read()).done ?? false;
    expect(done).toBe(true);
  } finally {
    abort.abort();
    await reader?.cancel().catch(() => {});
    await f.close();
  }
});
test("SSE rejects another event, invalid cursors, and avoids closed room replay", async () => {
  const f = await fixture();
  try {
    const a = await activeUser(f, "A"),
      b = await activeUser(f, "B");
    expect((await call(f, a, "GET", "/events/other/stream")).statusCode).toBe(
      404,
    );
    expect(
      (await call(f, a, "GET", "/events/evt/stream?afterEventId=bad"))
        .statusCode,
    ).toBe(422);
    await call(f, a, "POST", "/events/evt/likes", { targetProfileId: b.id });
    const r = (
      await call(f, b, "POST", "/events/evt/likes", { targetProfileId: a.id })
    ).json().data.conversationId;
    await call(f, a, "POST", `/events/evt/conversations/${r}/leave`, {
      expectedVersion: 1,
    });
    const base = await f.app.listen({ host: "127.0.0.1", port: 0 });
    const abort = new AbortController();
    try {
      const res = await fetch(
        base + "/api/v1/events/evt/stream?afterEventId=0",
        { headers: { cookie: a.cookie }, signal: abort.signal },
      );
      expect(res.status).toBe(200);
      const reader = res.body!.getReader();
      let text = "";
      while (!text.includes("conversation.closed"))
        text += new TextDecoder().decode((await reader.read()).value);
      expect(text).not.toContain("conversation.created");
      await reader.cancel();
    } finally {
      abort.abort();
    }
  } finally {
    await f.close();
  }
});
test("opaque cursor resumes after an event and is bound to its session", async () => {
  const f = await fixture();
  const abort = new AbortController();
  try {
    const a = await activeUser(f),
      b = await activeUser(f);
    await call(f, a, "POST", "/events/evt/likes", { targetProfileId: b.id });
    const r = (
      await call(f, b, "POST", "/events/evt/likes", { targetProfileId: a.id })
    ).json().data.conversationId;
    const base = await f.app.listen({ host: "127.0.0.1", port: 0 });
    const first = await fetch(base + "/api/v1/events/evt/stream", {
      headers: { cookie: a.cookie },
      signal: abort.signal,
    });
    const rd = first.body!.getReader();
    let text = "";
    while (!text.includes("conversation.created"))
      text += new TextDecoder().decode((await rd.read()).value);
    const cursor = text.match(/id: ([^\n]+)/)![1];
    expect(() => decodeCursor(cursor, a.csrf)).toThrow();
    await rd.cancel();
    expect(
      (await call(f, b, "GET", `/events/evt/stream?afterEventId=${cursor}`))
        .statusCode,
    ).toBe(422);
    await call(f, b, "POST", `/events/evt/conversations/${r}/messages`, {
      clientMessageId: "resume",
      text: "hello",
    });
    const second = await fetch(base + "/api/v1/events/evt/stream", {
      headers: { cookie: a.cookie, "Last-Event-ID": cursor },
      signal: abort.signal,
    });
    const rr = second.body!.getReader();
    text = "";
    while (!text.includes("message.created"))
      text += new TextDecoder().decode((await rr.read()).value);
    expect(text).not.toContain("conversation.created");
    await rr.cancel();
  } finally {
    abort.abort();
    await f.close();
  }
});
