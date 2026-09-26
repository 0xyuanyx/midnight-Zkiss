import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { test, expect } from "vitest";
import { registerWeb } from "../src/web-serving.js";

test("built mobile app and API share one origin without turning missing API paths into HTML", async () => {
  const root = await mkdtemp(join(tmpdir(), "zkiss-web-"));
  const app = Fastify();
  try {
    await mkdir(join(root, "assets"));
    await writeFile(join(root, "index.html"), "<html>mobile app</html>");
    await writeFile(join(root, "assets", "app.js"), "console.log('app')");
    app.get("/api/v1/ping", async () => ({ ok: true }));
    await registerWeb(app, root);
    await app.ready();
    expect((await app.inject("/api/v1/ping")).json()).toEqual({ ok: true });
    expect((await app.inject("/chats/room-1")).body).toContain("mobile app");
    expect((await app.inject("/assets/app.js")).body).toContain("console.log");
    expect((await app.inject("/api/v1/missing")).statusCode).toBe(404);
    expect((await app.inject("/assets/missing.js")).statusCode).toBe(404);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
