import { test, expect } from "vitest";
import { buildApp } from "../src/app.js";
import { localConfig } from "../src/config.js";
import { fixture, activeUser, call } from "./helpers.js";
test("separate HTTP clients recover persisted sessions and message history after server restart", async () => {
  const f = await fixture();
  let restarted: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    const a = await activeUser(f, "A"),
      b = await activeUser(f, "B");
    await call(f, a, "POST", "/events/evt/likes", { targetProfileId: b.id });
    const r = (
      await call(f, b, "POST", "/events/evt/likes", { targetProfileId: a.id })
    ).json().data.conversationId;
    const base = await f.app.listen({ port: 0, host: "127.0.0.1" });
    const sent = await fetch(
      base + `/api/v1/events/evt/conversations/${r}/messages`,
      {
        method: "POST",
        headers: {
          cookie: a.cookie,
          "X-CSRF-Token": a.csrf,
          "Idempotency-Key": "persist",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          clientMessageId: "persist",
          text: "persisted message",
        }),
      },
    );
    expect(sent.status).toBe(201);
    await f.app.close();
    restarted = await buildApp({ pool: f.pool, config: localConfig });
    const next = await restarted.listen({ port: 0, host: "127.0.0.1" });
    const read = await fetch(
      next + `/api/v1/events/evt/conversations/${r}/messages`,
      { headers: { cookie: b.cookie } },
    );
    expect(read.status).toBe(200);
    expect((await read.json()).data.items[0]).toMatchObject({
      sequence: 1,
      sender: "peer",
      text: "persisted message",
    });
  } finally {
    await restarted?.close();
    await f.close();
  }
});
