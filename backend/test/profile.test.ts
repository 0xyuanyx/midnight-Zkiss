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

test('generated images are persisted, owner-only before publication, and protected by event and block boundaries', async () => {
  const generated = await sharp({ create: { width: 12, height: 12, channels: 3, background: '#f0abcd' } }).png().toBuffer();
  const f = await fixture('demo', { ai: { mode: 'demo', analyze: async () => ({ intro: 'Generated intro', modelVersion: 'text-test', image: { bytes: Buffer.from(generated), mime: 'image/png', modelVersion: 'image-test' } }) } });
  try {
    const a = await activeUser(f), b = await activeUser(f), outside = await activeUser(f, 'Outside', 'other');
    const upload = await f.app.inject({ method: 'POST', url: '/api/v1/events/evt/me/ai-jobs', ...photo(a, png) });
    const done = await waitAi(f, a, upload.json().data.id);
    expect(done.status).toBe('succeeded');
    const mine = (await call(f, a, 'GET', '/me')).json().data.profile;
    expect(mine.imageUrl).toMatch(/^\/api\/v1\/events\/evt\/profile-images\/img_/);
    const request = (u: typeof a) => f.app.inject({ url: mine.imageUrl, headers: headers(u) });
    const owner = await request(a);
    expect(owner.statusCode).toBe(200);
    expect(owner.headers['content-type']).toBe('image/webp');
    expect((await request(b)).statusCode).toBe(404);
    expect((await f.app.inject(mine.imageUrl)).statusCode).toBe(401);
    expect((await request(outside)).statusCode).toBe(404);
    expect((await call(f, a, 'POST', '/events/evt/me/profile/publication', { expectedVersion: done.profileVersion })).statusCode).toBe(200);
    expect((await request(b)).statusCode).toBe(200);
    expect((await call(f, b, 'GET', `/events/evt/profiles/${a.id}`)).json().data.imageUrl).toBe(mine.imageUrl);
    await f.pool.query('INSERT INTO blocks(event_id,owner_id,target_id) VALUES($1,$2,$3)', ['evt', b.id, a.id]);
    expect((await request(b)).statusCode).toBe(404);
    const stored = (await f.pool.query('SELECT bytes FROM profile_images')).rows[0].bytes;
    expect(stored.equals(png)).toBe(false);
    expect((await sharp(stored).metadata()).format).toBe('webp');
  } finally { await f.close(); }
});

test('required image output fails the entire AI job when the provider only returns text', async () => {
  const { localConfig } = await import('../src/config.js');
  const f = await fixture('demo', { config: { ...localConfig, requireGeneratedImage: true } });
  try {
    const a = await activeUser(f);
    const upload = await f.app.inject({ method: 'POST', url: '/api/v1/events/evt/me/ai-jobs', ...photo(a, png) });
    const done = await waitAi(f, a, upload.json().data.id);
    expect(done).toMatchObject({ status: 'failed', failureCode: 'AI_IMAGE_REQUIRED' });
    expect((await call(f, a, 'GET', '/me')).json().data.profile.intro).toBe('테스트 소개');
    expect((await f.pool.query('SELECT count(*)::int AS n FROM profile_images')).rows[0].n).toBe(0);
  } finally { await f.close(); }
});

test('photo analysis receives the saved profile gender for avatar generation', async () => {
  let received: unknown;
  const f = await fixture('demo', {ai:{mode:'demo',async analyze(_photo:Buffer,_mime:string,_signal:AbortSignal,profile:unknown) { received=profile; return {intro:'단정한 인상이에요.',tags:['단정한 헤어','또렷한 눈매'],modelVersion:'test'}; }}});
  try {
    const u=await activeUser(f);
    await f.pool.query("UPDATE participants SET profile=jsonb_set(profile,'{gender}', '\"male\"') WHERE id=$1",[u.id]);
    const response=await f.app.inject({method:'POST',url:'/api/v1/events/evt/me/ai-jobs',...photo(u,png)});
    expect(response.statusCode).toBe(202);
    await waitAi(f,u,response.json().data.id);
    expect(received).toEqual({gender:'male'});
    expect((await f.pool.query('SELECT profile FROM participants WHERE id=$1',[u.id])).rows[0].profile.tags).toEqual(['단정한 헤어','또렷한 눈매']);
  } finally {await f.close();}
});
