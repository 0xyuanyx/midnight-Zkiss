import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  HTTPMethods,
} from "fastify";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { one, transaction, type Row } from "./db.js";
import type { Config } from "./config.js";
export const id = (prefix: string) => `${prefix}_${randomUUID()}`;
export const hash = (s: string | Buffer) =>
  createHash("sha256").update(s).digest("hex");
export const token = () => randomBytes(32).toString("base64url");
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    public fields: string[] = [],
  ) {
    super(code);
  }
}
export function fail(status: number, code: string): never {
  throw new ApiError(status, code);
}
export function need(
  value: unknown,
  status = 404,
  code = "RESOURCE_NOT_FOUND",
): asserts value {
  if (!value) fail(status, code);
}
export const identifier = z.string().min(1).max(200);
export const versionInput = z
  .object({ expectedVersion: z.number().int().min(0) })
  .strict();
export function checkVersion(actual: number, expected: number) {
  if (actual !== expected) fail(409, "VERSION_CONFLICT");
}
export const result = (data: unknown, status = 200) => ({
  data,
  status,
  replayed: false,
});
export function equal(a: string, b: string) {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export function envelope(data: unknown, req: FastifyRequest) {
  return {
    data,
    meta: { requestId: req.id, serverTime: new Date().toISOString() },
  };
}
export interface Ctx {
  db: PoolClient;
  request: FastifyRequest;
  reply: FastifyReply;
  p: Row;
  event: Row;
  uid: string;
  params: Record<string, string>;
  query: Record<string, string>;
  config: Config;
  revealCapabilities: { reveal: boolean; anonymousReveal: boolean };
}
export async function authenticate(db: Pool | PoolClient, req: FastifyRequest) {
  const cookie =
    req.cookies[req.server.getDecorator<string>("sessionCookieName")];
  need(cookie, 401, "SESSION_REQUIRED");
  const p = await one(
    db,
    "SELECT p.*,s.token_hash,s.csrf_token,s.cursor_secret,s.expires_at AS session_expires FROM sessions s JOIN participants p ON p.id=s.participant_id WHERE s.token_hash=$1 AND s.expires_at>now()",
    [hash(cookie)],
  );
  need(p, 401, "SESSION_EXPIRED");
  return p;
}
export interface RouteOptions {
  bodyLimit?: number;
  active?: boolean;
  phase?: "join" | "discover" | "chat" | "none";
  idempotent?: boolean;
  freshResponse?: boolean;
  afterCommit?: (req: FastifyRequest, data: unknown) => Promise<void>;
  preprocess?: (req: FastifyRequest) => Promise<() => void>;
}
export function router(app: FastifyInstance, pool: Pool, config: Config) {
  return (
    method: HTTPMethods,
    url: string,
    handler: (c: Ctx) => Promise<{ data: unknown; status: number }>,
    options: RouteOptions = {},
  ) => {
    app.route({
      method,
      bodyLimit: options.bodyLimit,
      url: "/api/v1" + url,
      handler: async (request, reply) => {
        let cleanup: (() => void) | undefined;
        if (options.preprocess) {
          const auth = await authenticate(pool, request);
          if (
            !equal(
              auth.csrf_token,
              String(request.headers["x-csrf-token"] ?? ""),
            )
          )
            fail(403, "CSRF_INVALID");
          cleanup = await options.preprocess(request);
        }
        try {
          const output = await transaction(pool, async (db) => {
            let p = await authenticate(db, request);
            const params = request.params as Record<string, string>;
            if (params.eventId && params.eventId !== p.event_id)
              fail(404, "RESOURCE_NOT_FOUND");
            const write = method !== "GET";
            const event = await one(
              db,
              `SELECT * FROM events WHERE id=$1 ${write ? "FOR UPDATE" : ""}`,
              [p.event_id],
            );
            need(event);
            // Recheck after the event lock: workers/logout may have changed permissions while we waited.
            if (write) p = await authenticate(db, request);
            if (
              write &&
              !equal(
                p.csrf_token,
                String(request.headers["x-csrf-token"] ?? ""),
              )
            )
              fail(403, "CSRF_INVALID");
            if (
              write &&
              url !== "/sessions/current" &&
              !["onboarding", "admission_pending", "active"].includes(
                p.admission_status,
              )
            )
              fail(403, "ACCOUNT_SUSPENDED");
            if (options.active !== false && p.admission_status !== "active")
              fail(403, "ADMISSION_REQUIRED");
            const phase = options.phase ?? "none";
            if (
              phase !== "none" &&
              (event.status !== "open" ||
                new Date(event[`${phase}_until`]).getTime() <= Date.now())
            )
              fail(409, "EVENT_CLOSED");
            const c: Ctx = {
              db,
              request,
              reply,
              p,
              event,
              uid: p.id,
              params,
              query: request.query as Record<string, string>,
              config,
              revealCapabilities: app.getDecorator("revealCapabilities"),
            };
            const key = String(request.headers["idempotency-key"] ?? "");
            if (options.idempotent && !key)
              fail(400, "IDEMPOTENCY_KEY_REQUIRED");
            if (key.length > 200) fail(422, "VALIDATION_ERROR");
            const scope = `${method}:${url}:${JSON.stringify(params)}`;
            // Stable body representation: object keys are canonicalized, independent of property order.
            const payloadHash = hash(canonical(request.body ?? null));
            if (write && key && !options.freshResponse) {
              const old = await one(
                db,
                "SELECT * FROM idempotency WHERE owner_id=$1 AND scope=$2 AND key=$3",
                [p.id, scope, key],
              );
              if (old) {
                if (old.body?.conversation?.id)
                  await room(c, old.body.conversation.id, true);
                if (params.conversationId && url.endsWith("/reveal-requests")) {
                  await room(c, params.conversationId, true);
                  const current = await one(
                    db,
                    "SELECT * FROM reveal_requests WHERE id=$1 AND conversation_id=$2",
                    [old.body.id, params.conversationId],
                  );
                  need(
                    current &&
                      current.version === old.body.version &&
                      new Date(current.expires_at).getTime() > Date.now(),
                    409,
                    "VERSION_CONFLICT",
                  );
                }
                if (params.conversationId && url.endsWith("/messages"))
                  await room(c, params.conversationId, true);
                if (params.requestId && url.includes("/reveal-requests/")) {
                  const current = await one(
                    db,
                    "SELECT * FROM reveal_requests WHERE id=$1 AND event_id=$2 AND (a=$3 OR b=$3)",
                    [params.requestId, event.id, p.id],
                  );
                  need(current);
                  await room(c, current.conversation_id, true);
                  need(
                    current.version === old.body?.version &&
                      new Date(current.expires_at).getTime() > Date.now(),
                    409,
                    "VERSION_CONFLICT",
                  );
                }
                if (old.payload_hash !== payloadHash)
                  fail(409, "IDEMPOTENCY_CONFLICT");
                return { ...result(old.body, old.status_code), replayed: true };
              }
            }
            const out = await handler(c);
            if (write && key && !options.freshResponse)
              await db.query(
                "INSERT INTO idempotency(owner_id,scope,key,payload_hash,status_code,body) VALUES($1,$2,$3,$4,$5,$6)",
                [
                  p.id,
                  scope,
                  key,
                  payloadHash,
                  out.status,
                  JSON.stringify(out.data ?? null),
                ],
              );
            return out;
          });
          if (!("replayed" in output) || !output.replayed)
            await options.afterCommit?.(request, output.data);
          reply.code(output.status);
          return output.status === 204
            ? reply.send()
            : envelope(output.data, request);
        } finally {
          cleanup?.();
        }
      },
    });
  };
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
export async function emit(
  c: Pick<Ctx, "db" | "event">,
  audience: string,
  kind: string,
  resource: string,
  room: string | null = null,
  version = 1,
) {
  await c.db.query(
    "INSERT INTO outbox(event_id,audience,kind,resource_id,conversation_id,version) VALUES($1,$2,$3,$4,$5,$6)",
    [c.event.id, audience, kind, resource, room, version],
  );
}
export async function blocked(
  db: Pool | PoolClient,
  event: string,
  a: string,
  b: string,
) {
  return !!(await one(
    db,
    "SELECT 1 FROM blocks WHERE event_id=$1 AND ((owner_id=$2 AND target_id=$3) OR (owner_id=$3 AND target_id=$2))",
    [event, a, b],
  ));
}
export async function room(
  c: Ctx,
  roomId = c.params.conversationId,
  active = false,
) {
  const r = await one(
    c.db,
    "SELECT * FROM conversations WHERE id=$1 AND event_id=$2 AND (a=$3 OR b=$3)",
    [roomId, c.event.id, c.uid],
  );
  need(r);
  if (active) {
    const peers = await one(
      c.db,
      "SELECT count(*)::int AS n FROM participants WHERE id=ANY($1::text[]) AND event_id=$2 AND admission_status='active'",
      [[r.a, r.b], c.event.id],
    );
    need(
      peers!.n === 2 && !(await blocked(c.db, c.event.id, r.a, r.b)),
      409,
      "CONVERSATION_CLOSED",
    );
  }
  if (active)
    need(
      r.status === "active" &&
        new Date(c.event.chat_until).getTime() > Date.now() &&
        c.event.status === "open",
      409,
      "CONVERSATION_CLOSED",
    );
  return r;
}
export async function limit(c: Ctx, kind: string, max: number, seconds = 60) {
  const key = `${c.uid}:${kind}`;
  const row = await one(
    c.db,
    "INSERT INTO rate_buckets(key) VALUES($1) ON CONFLICT(key) DO UPDATE SET hits=CASE WHEN rate_buckets.window_start<now()-($2*interval '1 second') THEN 1 ELSE rate_buckets.hits+1 END,window_start=CASE WHEN rate_buckets.window_start<now()-($2*interval '1 second') THEN now() ELSE rate_buckets.window_start END RETURNING hits",
    [key, seconds],
  );
  if (row!.hits > max) {
    c.reply.header("Retry-After", seconds);
    fail(429, "RATE_LIMITED");
  }
}
export function pagination(c: Ctx) {
  const q = z
    .object({
      cursor: z.string().max(200).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(30),
    })
    .passthrough()
    .parse(c.query);
  return q;
}
export function page(rows: Row[], limit: number) {
  const items = rows.slice(0, limit);
  return { items, nextCursor: rows.length > limit ? items.at(-1)!.id : null };
}

export async function providerCall<T>(
  action: () => Promise<T>,
  code = "FEATURE_NOT_READY",
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      action(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("provider timeout")), 10000);
      }),
    ]);
  } catch {
    fail(503, code);
  } finally {
    clearTimeout(timer);
  }
}
