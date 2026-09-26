import { access } from "node:fs/promises";
import { join, resolve } from "node:path";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";

/** Serves the built mobile app from the API origin so sessions stay first-party. */
export async function registerWeb(app: FastifyInstance, directory: string) {
  const root = resolve(directory);
  await access(join(root, "index.html"));
  await app.register(fastifyStatic, {
    root,
    wildcard: false,
    cacheControl: false,
  });
  app.get("/*", (request, reply) => {
    const path = new URL(request.url, "http://localhost").pathname;
    if (path.startsWith("/api/") || path === "/health" || /\.[^/]+$/.test(path)) {
      return reply.callNotFound();
    }
    return reply.type("text/html; charset=utf-8").sendFile("index.html");
  });
}
