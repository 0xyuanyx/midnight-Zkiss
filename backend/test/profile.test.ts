import sharp from "sharp";
import { test, expect } from "vitest";
import { fixture, user, activeUser, call, headers, waitAi } from "./helpers.js";
function photo(
  u: { cookie: string; csrf: string },
  bytes: Buffer,
  mime = "image/png",
) {
  const boundary = "zkiss-test";
  return {
    headers: {
      ...headers(u),
      "content-type": `multipart/form-data; boundary=${boundary}`,
    },
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="expectedVersion"\r\n\r\n1\r\n--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="photo.png"\r\nContent-Type: ${mime}\r\n\r\n`,
      ),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
}
const png = await sharp({
  create: { width: 2, height: 2, channels: 3, background: "#123456" },
})
  .png()
  .toBuffer();
test("AI description cannot be supplied by a profile update or published from a mismatched draft", async () => {
  const f = await fixture();
  try {
    const u = await activeUser(f);
    const tamper = await call(f, u, "PUT", "/events/evt/me/profile", {
      expectedVersion: 1, nickname: "X", age: 24, gender: "unspecified", intro: "fake AI",
    });
    expect(tamper.statusCode).toBe(422);
    await f.pool.query("UPDATE participants SET profile_status='draft',profile=jsonb_set(profile,'{intro}',to_jsonb('fake AI'::text)) WHERE id=$1", [u.id]);
    await f.pool.query("INSERT INTO ai_jobs(id,owner_id,profile_version,mode,status,result,cleanup_status) VALUES($1,$2,1,'demo','succeeded','original AI','service_cleaned')", ["ai_tamper", u.id]);
    const publish = await call(f, u, "POST", "/events/evt/me/profile/publication", { expectedVersion: 1 });
    expect(publish.statusCode).toBe(409);
  } finally { await f.close(); }
});
test("profile versions reject lost updates and onboarding cannot publish", async () => {
  const f = await fixture();
  try {
    const u = await user(f);
    const input = {
      expectedVersion: 0,
      nickname: "가나다",
      age: 24,
      gender: "unspecified",
    };
    const save = await call(f, u, "PUT", "/events/evt/me/profile", input);
    expect(save.statusCode).toBe(200);
    expect(save.json().data.version).toBe(1);
    expect(
      (await call(f, u, "PUT", "/events/evt/me/profile", input)).statusCode,
    ).toBe(409);
    expect(
      (
        await call(f, u, "POST", "/events/evt/me/profile/publication", {
          expectedVersion: 1,
        })
      ).statusCode,
    ).toBe(403);
  } finally {
    await f.close();
  }
});
test("AI processes a bounded in-memory photo, persists only text, and marks demo/cleanup", async () => {
  const f = await fixture();
  try {
    const u = await activeUser(f);
    const r = await f.app.inject({
      method: "POST",
      url: "/api/v1/events/evt/me/ai-jobs",
      ...photo(u, png),
    });
    expect(r.statusCode).toBe(202);
    const done = await waitAi(f, u, r.json().data.id);
    expect(done).toMatchObject({
      status: "succeeded",
      cleanupStatus: "service_cleaned",
      mode: "demo",
    });
    const stored = (await f.pool.query("SELECT * FROM ai_jobs")).rows;
    expect(stored).toHaveLength(1);
    expect(JSON.stringify(stored)).not.toContain(png.toString("base64"));
    const publish = await call(
      f,
      u,
      "POST",
      "/events/evt/me/profile/publication",
      { expectedVersion: done.profileVersion },
    );
    expect(publish.statusCode).toBe(200);
  } finally {
    await f.close();
  }
});
test("non-image and oversized uploads are rejected and real AI never silently uses demo", async () => {
  const f = await fixture();
  try {
    const u = await activeUser(f);
    expect(
      (
        await f.app.inject({
          method: "POST",
          url: "/api/v1/events/evt/me/ai-jobs",
          ...photo(u, Buffer.from("not an image")),
        })
      ).statusCode,
    ).toBe(415);
    expect(
      (
        await f.app.inject({
          method: "POST",
          url: "/api/v1/events/evt/me/ai-jobs",
          ...photo(u, Buffer.alloc(6 * 1024 * 1024)),
        })
      ).statusCode,
    ).toBe(413);
  } finally {
    await f.close();
  }
  const real = await fixture("real");
  try {
    const u = await activeUser(real);
    expect(
      (
        await real.app.inject({
          method: "POST",
          url: "/api/v1/events/evt/me/ai-jobs",
          ...photo(u, png),
        })
      ).statusCode,
    ).toBe(503);
  } finally {
    await real.close();
  }
});
test("feed hides unpublished, self, cross-event and blocked profiles", async () => {
  const f = await fixture();
  try {
    const a = await activeUser(f, "A"),
      b = await activeUser(f, "B");
    await activeUser(f, "outside", "other");
    let r = await call(f, a, "GET", "/events/evt/feed");
    expect(r.statusCode).toBe(200);
    expect(r.json().data.items.map((x: any) => x.profile.profileId)).toEqual([
      b.id,
    ]);
    await f.pool.query(
      "INSERT INTO blocks(event_id,owner_id,target_id) VALUES($1,$2,$3)",
      ["evt", b.id, a.id],
    );
    r = await call(f, a, "GET", "/events/evt/feed");
    expect(r.json().data.items).toEqual([]);
    expect(
      (await call(f, a, "GET", `/events/evt/profiles/${b.id}`)).statusCode,
    ).toBe(404);
  } finally {
    await f.close();
  }
});

test("valid magic bytes with corrupt pixel data never reach AI", async () => {
  const f = await fixture();
  try {
    const u = await activeUser(f);
    const corrupt = Buffer.from(
      "89504e470d0a1a0a0000000049454e44ae426082",
      "hex",
    );
    const r = await f.app.inject({
      method: "POST",
      url: "/api/v1/events/evt/me/ai-jobs",
      ...photo(u, corrupt),
    });
    expect(r.statusCode).toBe(422);
    expect((await f.pool.query("SELECT * FROM ai_jobs")).rows).toHaveLength(0);
  } finally {
    await f.close();
  }
});
test("AI returns a durable processing job without holding the event write lock", async () => {
  let finish: (v: { intro: string; modelVersion: string }) => void = () => {};
  const ai = {
    mode: "demo" as const,
    analyze: () =>
      new Promise<{ intro: string; modelVersion: string }>((resolve) => {
        finish = resolve;
      }),
  };
  const f = await fixture("demo", { ai });
  try {
    const a = await activeUser(f),
      b = await activeUser(f);
    const upload = f.app.inject({
      method: "POST",
      url: "/api/v1/events/evt/me/ai-jobs",
      ...photo(a, png),
    });
    const first = await upload;
    expect(first.json().data.status).toBe("processing");
    const edit = await call(f, b, "PUT", "/events/evt/me/profile", {
      expectedVersion: 1,
      nickname: "B",
      age: 24,
      gender: "unspecified",
    });
    expect(edit.statusCode).toBe(200);
    finish({ intro: "AI intro", modelVersion: "fixture" });
  } finally {
    finish({ intro: "AI intro", modelVersion: "fixture" });
    await f.close();
  }
});
test("late AI output cannot overwrite a newer draft and its input buffer is cleared", async () => {
  let finish: (v: { intro: string; modelVersion: string }) => void = () => {};
  let held: Buffer | undefined;
  const ai = {
    mode: "demo" as const,
    analyze: (bytes: Buffer) => {
      held = bytes;
      return new Promise<{ intro: string; modelVersion: string }>((resolve) => {
        finish = resolve;
      });
    },
  };
  const f = await fixture("demo", { ai });
  try {
    const a = await activeUser(f);
    const r = await f.app.inject({
      method: "POST",
      url: "/api/v1/events/evt/me/ai-jobs",
      ...photo(a, png),
    });
    expect(r.statusCode).toBe(202);
    await call(f, a, "PUT", "/events/evt/me/profile", {
      expectedVersion: 1,
      nickname: "New draft",
      age: 24,
      gender: "unspecified",
    });
    finish({ intro: "stale AI", modelVersion: "fixture" });
    const job = await waitAi(f, a, r.json().data.id);
    expect(job).toMatchObject({
      status: "failed",
      failureCode: "PROFILE_CHANGED",
      cleanupStatus: "service_cleaned",
    });
    expect(held?.every((byte) => byte === 0)).toBe(true);
    expect((await call(f, a, "GET", "/me")).json().data.profile.intro).toBe("테스트 소개");
  } finally {
    finish({ intro: "cleanup", modelVersion: "fixture" });
    await f.close();
  }
});

test("real AI records external processing independently of demo chain mode", async () => {
  const { localConfig } = await import('../src/config.js');
  const f = await fixture('demo', { config: { ...localConfig, aiMode: 'real' }, ai: { mode: 'real', analyze: async () => ({ intro: '첫 문단이에요.\n\n둘째 문단이에요.', modelVersion: 'real-provider-test' }) } });
  try {
    const u = await activeUser(f);
    const r = await f.app.inject({ method: 'POST', url: '/api/v1/events/evt/me/ai-jobs', ...photo(u, png) });
    expect(r.statusCode).toBe(202);
    const done = await waitAi(f, u, r.json().data.id);
    expect(done).toMatchObject({ status: 'succeeded', mode: 'real', providerRetentionStatus: 'unverified', result: '첫 문단이에요.\n\n둘째 문단이에요.' });
  } finally { await f.close(); }
});

test("one AI job can finish after one attempt timeout without creating another job", async () => {
  const { localConfig } = await import('../src/config.js');
  const ai = { mode: 'demo' as const, analyze: async () => {
    await new Promise(resolve => setTimeout(resolve, 70));
    return { intro: '뒤늦게 도착한 소개예요.', modelVersion: 'delayed-test' };
  } };
  const f = await fixture('demo', { config: { ...localConfig, aiTimeoutMs: 20 }, ai });
  try {
    const u = await activeUser(f);
    const r = await f.app.inject({ method: 'POST', url: '/api/v1/events/evt/me/ai-jobs', ...photo(u, png) });
    expect(r.statusCode).toBe(202);
    const done = await waitAi(f, u, r.json().data.id);
    expect(done.status).toBe('succeeded');
    expect((await f.pool.query('SELECT count(*)::int AS n FROM ai_jobs')).rows[0].n).toBe(1);
  } finally { await f.close(); }
});

test("missing real AI never falls back to demo analysis", async () => {
  const { localConfig } = await import('../src/config.js');
  const f = await fixture('demo', { config: { ...localConfig, aiMode: 'real' } });
  try {
    const event = await f.app.inject('/api/v1/events/evt');
    expect(event.json().data).toMatchObject({ aiMode: 'real', aiReady: false });
    const u = await activeUser(f);
    const r = await f.app.inject({ method: 'POST', url: '/api/v1/events/evt/me/ai-jobs', ...photo(u, png) });
    expect(r.statusCode).toBe(503);
    expect((await f.pool.query('SELECT count(*)::int AS count FROM ai_jobs')).rows[0].count).toBe(0);
  } finally { await f.close(); }
});
test("participant introduction is limited to 20 characters and published with the profile", async () => {
  const f = await fixture();
  try {
    const a = await activeUser(f, "A"),
      b = await activeUser(f, "B");
    const base = { expectedVersion: 1, nickname: "B", age: 24, gender: "unspecified" };
    expect((await call(f, b, "PUT", "/events/evt/me/profile", { ...base, introduction: "가".repeat(21) })).statusCode).toBe(422);
    const saved = await call(f, b, "PUT", "/events/evt/me/profile", { ...base, introduction: "전시와 음악을 좋아해요." });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().data).toMatchObject({ introduction: "전시와 음악을 좋아해요.", intro: "테스트 소개" });
    // Drafts stay private until publication; publication copies the whole profile.
    expect((await call(f, a, "GET", "/events/evt/feed")).json().data.items[0].profile.introduction).toBe("");
    await f.pool.query("UPDATE participants SET published_profile=profile WHERE id=$1", [b.id]);
    expect((await call(f, a, "GET", "/events/evt/feed")).json().data.items[0].profile.introduction).toBe("전시와 음악을 좋아해요.");
  } finally {
    await f.close();
  }
});
