import { randomUUID } from "node:crypto";
import { Pool } from "pg";
export async function database() {
  const url =
    process.env.TEST_DATABASE_URL ??
    "postgres://zkiss:local-development-only@127.0.0.1:55432/zkiss";
  const admin = new Pool({ connectionString: url });
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({
    connectionString: url,
    options: `-c search_path=${schema}`,
    max: 10,
  });
  return {
    pool,
    async close() {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    },
  };
}

export async function fixture(
  mode: "demo" | "real" = "demo",
  extra: Record<string, unknown> = {},
) {
  const { migrate } = await import("../src/db.js");
  const { buildApp } = await import("../src/app.js");
  const { localConfig } = await import("../src/config.js");
  const db = await database();
  await migrate(db.pool);
  await db.pool.query(
    "INSERT INTO events(id,name,join_until,discover_until,chat_until,modes,sns_reveal) VALUES('evt','Event',now()+interval '1 day',now()+interval '1 day',now()+interval '2 days','[\"mutual_like\",\"question_reply\"]',true),('other','Other',now()+interval '1 day',now()+interval '1 day',now()+interval '2 days','[]',false)",
  );
  await db.pool.query(
    "UPDATE events SET midnight_network=$1,midnight_contract_address=$2,midnight_event_scope=$3",
    [mode === "demo" ? "demo" : "test", "a".repeat(64), "b".repeat(64)],
  );
  const app = await buildApp({
    pool: db.pool,
    config: { ...localConfig, mode, sessionRateLimit: 1000 },
    ...extra,
  });
  await app.ready();
  return {
    app,
    pool: db.pool,
    async close() {
      await app.close();
      await db.close();
    },
  };
}
export async function user(
  f: Awaited<ReturnType<typeof fixture>>,
  eventId = "evt",
) {
  const res = await f.app.inject({
    method: "POST",
    url: "/api/v1/sessions",
    payload: { eventId },
  });
  if (res.statusCode !== 201)
    throw new Error(`session: ${res.statusCode} ${res.body}`);
  const data = res.json().data;
  return {
    id: data.participantId as string,
    cookie: res.cookies.map((c) => `${c.name}=${c.value}`).join("; "),
    csrf: data.csrfToken as string,
  };
}
export function headers(u: { cookie: string; csrf: string }, key?: string) {
  return {
    cookie: u.cookie,
    "x-csrf-token": u.csrf,
    ...(key ? { "idempotency-key": key } : {}),
  };
}
export async function activeUser(
  f: Awaited<ReturnType<typeof fixture>>,
  name = "user",
  event = "evt",
) {
  const u = await user(f, event);
  await f.pool.query(
    "UPDATE participants SET admission_status='active',device_public_key=$2,device_key_version=1,profile_status='published',profile_version=1,profile=$3,published_profile=$3,published_version=1 WHERE id=$1",
    [
      u.id,
      Buffer.alloc(32, 1).toString("base64"),
      JSON.stringify({
        nickname: name,
        age: 24,
        gender: "unspecified",
        intro: "테스트 소개",
        introSource: "ai",
        tags: [],
      }),
    ],
  );
  return u;
}
export async function call(
  f: Awaited<ReturnType<typeof fixture>>,
  u: { cookie: string; csrf: string },
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  payload?: unknown,
  key: string = randomUUID(),
) {
  return f.app.inject({
    method,
    url: "/api/v1" + path,
    headers: headers(u, key),
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
}

export async function waitAi(
  f: Awaited<ReturnType<typeof fixture>>,
  u: Awaited<ReturnType<typeof user>>,
  jobId: string,
) {
  for (let n = 0; n < 100; n++) {
    const r = await call(f, u, "GET", `/events/evt/me/ai-jobs/${jobId}`);
    if (r.json().data.status !== "processing") return r.json().data;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("AI did not complete");
}

/** Explicit fixture setup for tests whose subject is intent verification, not ticket issuance. */
export async function issuedTicket(
  f: Awaited<ReturnType<typeof fixture>>,
  u: Awaited<ReturnType<typeof user>>,
) {
  await f.pool.query(
    "UPDATE participants SET ticket_leaf=$2,ticket_status='issued',ticket_event=(SELECT jsonb_build_object('network',midnight_network,'contractAddress',midnight_contract_address,'eventScope',midnight_event_scope) FROM events WHERE id=participants.event_id) WHERE id=$1",
    [u.id, randomUUID().replaceAll("-", "").padEnd(64, "0")],
  );
}
export async function collectMaterials(
  f: Awaited<ReturnType<typeof fixture>>,
  a: Awaited<ReturnType<typeof user>>,
  b: Awaited<ReturnType<typeof user>>,
  r: any,
) {
  const { demoMidnight, createDemoOperator } = await import(
    "../src/adapters/demo-midnight.js"
  );
  const { processChainJobs } = await import("../src/chain-jobs.js");
  for (const [index, u] of [a, b].entries()) {
    const response = await call(
      f,
      u,
      "PUT",
      `/events/evt/reveal-requests/${r.id}/room-material`,
      {
        slot: String(index + 1).repeat(64),
        roomPublicKey: Buffer.alloc(32, index + 1).toString("base64"),
        keyCommit: String(index + 3).repeat(64),
        contactCommit: String(index + 5).repeat(64),
      },
    );
    if (response.statusCode !== 200) throw new Error(response.body);
  }
  await processChainJobs(f.pool, demoMidnight, createDemoOperator());
  return (await call(f, a, "GET", `/events/evt/reveal-requests/${r.id}`)).json()
    .data;
}
