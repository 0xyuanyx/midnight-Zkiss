import Fastify from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import { ZodError } from "zod";
import type { Pool } from "pg";
import type { Config } from "./config.js";
import { ApiError, envelope, fail } from "./http.js";
import { sessions } from "./routes/sessions.js";
import { profiles } from "./routes/profiles.js";
import { chain } from "./routes/chain.js";
import { demoAi, type AiProvider } from "./adapters/ai.js";
import { demoMidnight } from "./adapters/demo-midnight.js";
import type { MidnightAdapter } from "./adapters/midnight.js";
import { connections } from "./routes/connections.js";
import { conversations } from "./routes/conversations.js";
import { safety } from "./routes/safety.js";
import { stream } from "./routes/stream.js";
import { reveal } from "./routes/reveal.js";
export async function buildApp(options: {
  pool: Pool;
  config: Config;
  ai?: AiProvider;
  midnight?: MidnightAdapter;
}) {
  const app = Fastify({ logger: false, bodyLimit: 16384 });
  app.decorate(
    "sessionCookieName",
    options.config.mode === "real" ? "__Host-zkiss_session" : "zkiss_session",
  );
  await app.register(cookie);
  await app.register(multipart, {
    limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 2, parts: 3 },
  });
  await app.register(rateLimit, { max: 300, timeWindow: "1 minute" });
  app.addHook("onRequest", async (req) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return;
    const origin = req.headers.origin;
    const expected = options.config.origin ?? `${req.protocol}://${req.host}`;
    if (origin && origin !== expected) fail(403, "ORIGIN_INVALID");
    if (req.headers["sec-fetch-site"] === "cross-site")
      fail(403, "ORIGIN_INVALID");
  });
  app.addHook("onSend", async (_req, reply) => {
    reply.header("Cache-Control", "no-store");
    reply.header("X-Content-Type-Options", "nosniff");
  });
  app.setErrorHandler((error, req, reply) => {
    const e = error as Error & { statusCode?: number; code?: string };
    let status = 500,
      code = "INTERNAL_ERROR",
      fields: string[] = [];
    if (e instanceof ApiError) {
      status = e.status;
      code = e.code;
      fields = e.fields;
    } else if (e instanceof ZodError) {
      status = 422;
      code = "VALIDATION_ERROR";
      fields = e.issues.map((i) => i.path.join("."));
    } else if (e.statusCode === 429) {
      status = 429;
      code = "RATE_LIMITED";
    } else if (e.statusCode === 413) {
      status = 413;
      code = "FILE_TOO_LARGE";
    } else if (e.statusCode === 400) {
      status = 400;
      code = "MALFORMED_REQUEST";
    } else if (e.statusCode === 415) {
      status = 415;
      code = "UNSUPPORTED_MEDIA_TYPE";
    }
    reply.code(status).send({
      error: { code, fields, retryable: [429, 503].includes(status) },
      meta: { requestId: req.id, serverTime: new Date().toISOString() },
    });
  });
  app.setNotFoundHandler((req, reply) =>
    reply.code(404).send({
      error: { code: "RESOURCE_NOT_FOUND", fields: [], retryable: false },
      meta: { requestId: req.id, serverTime: new Date().toISOString() },
    }),
  );
  app.get("/health", async (req) => {
    await options.pool.query("SELECT 1");
    return envelope({ status: "ok", mode: options.config.mode }, req);
  });
  const adapter =
    options.midnight ??
    (options.config.mode === "demo" ? demoMidnight : undefined);
  app.decorate("revealCapabilities", {
    reveal: !!(
      adapter?.mode === options.config.mode &&
      adapter?.capabilities.reveal &&
      typeof adapter?.revealTerms === "function" &&
      typeof adapter?.revealStatus === "function"
    ),
    anonymousReveal: !!adapter?.capabilities.anonymousReveal,
  });
  sessions(
    app,
    options.pool,
    options.config,
    !!(
      adapter?.mode === options.config.mode &&
      adapter?.capabilities.reveal &&
      typeof adapter?.revealTerms === "function" &&
      typeof adapter?.revealStatus === "function"
    ),
  );
  profiles(
    app,
    options.pool,
    options.config,
    options.ai ?? (options.config.mode === "demo" ? demoAi : undefined),
  );
  chain(
    app,
    options.pool,
    options.config,
    options.midnight ??
      (options.config.mode === "demo" ? demoMidnight : undefined),
  );
  connections(app, options.pool, options.config);
  conversations(app, options.pool, options.config);
  safety(app, options.pool, options.config);
  reveal(
    app,
    options.pool,
    options.config,
    options.midnight ??
      (options.config.mode === "demo" ? demoMidnight : undefined),
  );
  stream(app, options.pool);
  return app;
}
