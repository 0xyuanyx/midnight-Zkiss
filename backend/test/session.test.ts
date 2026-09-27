import { test, expect } from "vitest";
import { fixture, user, headers } from "./helpers.js";
test("bootstrap creates an onboarding session, not admission; protected reads need the cookie", async () => {
  const f = await fixture();
  try {
    const res = await f.app.inject({
      method: "POST",
      url: "/api/v1/sessions",
      payload: { eventId: "evt" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().data.admissionStatus).toBe("onboarding");
    expect(res.headers["set-cookie"]).toContain("HttpOnly");
    expect((await f.app.inject("/api/v1/me")).statusCode).toBe(401);
    const rawCookie = res.cookies[0].value;
    const stored = (await f.pool.query("SELECT token_hash FROM sessions"))
      .rows[0].token_hash;
    expect(stored).not.toBe(rawCookie);
  } finally {
    await f.close();
  }
});
test("same browser resumes its session and cannot silently switch events", async () => {
  const f = await fixture();
  try {
    const u = await user(f);
    const same = await f.app.inject({
      method: "POST",
      url: "/api/v1/sessions",
      headers: { cookie: u.cookie },
      payload: { eventId: "evt" },
    });
    expect(same.statusCode).toBe(200);
    expect(same.json().data.participantId).toBe(u.id);
    const other = await f.app.inject({
      method: "POST",
      url: "/api/v1/sessions",
      headers: { cookie: u.cookie },
      payload: { eventId: "other" },
    });
    expect(other.statusCode).toBe(409);
    expect(
      (
        await f.app.inject({
          url: "/api/v1/events/other/feed",
          headers: headers(u),
        })
      ).statusCode,
    ).toBe(404);
  } finally {
    await f.close();
  }
});
test("logout requires CSRF and revokes the session", async () => {
  const f = await fixture();
  try {
    const u = await user(f);
    expect(
      (
        await f.app.inject({
          method: "DELETE",
          url: "/api/v1/sessions/current",
          headers: { cookie: u.cookie },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await f.app.inject({
          method: "DELETE",
          url: "/api/v1/sessions/current",
          headers: headers(u),
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (await f.app.inject({ url: "/api/v1/me", headers: headers(u) }))
        .statusCode,
    ).toBe(401);
  } finally {
    await f.close();
  }
});
test("unknown fields and expired events cannot bootstrap participants", async () => {
  const f = await fixture();
  try {
    expect(
      (
        await f.app.inject({
          method: "POST",
          url: "/api/v1/sessions",
          payload: { eventId: "evt", active: true },
        })
      ).statusCode,
    ).toBe(422);
    await f.pool.query(
      "UPDATE events SET join_until=now()-interval '1 second' WHERE id='evt'",
    );
    expect(
      (
        await f.app.inject({
          method: "POST",
          url: "/api/v1/sessions",
          payload: { eventId: "evt" },
        })
      ).statusCode,
    ).toBe(409);
  } finally {
    await f.close();
  }
});
test("real session cookie is host-bound and Secure", async () => {
  const f = await fixture("real");
  try {
    const r = await f.app.inject({
      method: "POST",
      url: "/api/v1/sessions",
      payload: { eventId: "evt" },
    });
    expect(r.headers["set-cookie"]).toContain("__Host-zkiss_session=");
    expect(r.headers["set-cookie"]).toContain("Secure");
  } finally {
    await f.close();
  }
});

test('MVP open admission creates an active session without a ticket or chain intent', async () => {
  const { localConfig } = await import('../src/config.js');
  const f = await fixture('real', { config: { ...localConfig, mode: 'real', admissionMode: 'open', defaultEventId: 'evt' } });
  try {
    const publicKey = Buffer.alloc(32, 3).toString('base64');
    const response = await f.app.inject({ method: 'POST', url: '/api/v1/sessions', payload: { devicePublicKey: publicKey } });
    expect(response.statusCode).toBe(201);
    expect(response.json().data).toMatchObject({ eventId: 'evt', admissionStatus: 'active', devicePublicKey: publicKey, contact: { keyVersion: 1 } });
    const cookie = response.cookies.map(c => `${c.name}=${c.value}`).join('; ');
    expect((await f.app.inject({ url: '/api/v1/events/evt/feed', headers: { cookie } })).statusCode).toBe(200);
    expect((await f.pool.query('SELECT count(*)::int AS n FROM chain_intents')).rows[0].n).toBe(0);
    expect((await f.pool.query('SELECT count(*)::int AS n FROM chain_jobs')).rows[0].n).toBe(0);
    const resumed = await f.app.inject({ method: 'POST', url: '/api/v1/sessions', headers: { cookie }, payload: {} });
    expect(resumed.json().data.participantId).toBe(response.json().data.participantId);
  } finally { await f.close(); }
});

test('default MVP event is prepared once without overwriting its chain scope', async () => {
  const { localConfig } = await import('../src/config.js');
  const { ensureDefaultEvent } = await import('../src/default-event.js');
  const f = await fixture();
  try {
    const config = { ...localConfig, admissionMode: 'open' as const, defaultEventId: 'mvp' };
    await ensureDefaultEvent(f.pool, config);
    const original = (await f.pool.query("SELECT * FROM events WHERE id='mvp'")).rows[0];
    expect(original.modes).toEqual(['mutual_like']);
    await ensureDefaultEvent(f.pool, { ...config, midnightNetwork: 'other', midnightContractAddress: 'c'.repeat(64), midnightEventScope: 'd'.repeat(64) });
    const after = (await f.pool.query("SELECT * FROM events WHERE id='mvp'")).rows[0];
    expect(after.join_until).toEqual(original.join_until);
    expect(after.midnight_contract_address).toEqual(original.midnight_contract_address);
  } finally { await f.close(); }
});
