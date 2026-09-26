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
