import { test, expect } from "vitest";
import * as config from "../src/config.js";
test("runtime defaults to real, requires DB, validates ports and secure cookies", () => {
  const load = (config as any).loadConfig;
  expect(typeof load).toBe("function");
  expect(() => load({})).toThrow();
  expect(() =>
    load({ DATABASE_URL: "postgres://localhost/db", PORT: "bad" }),
  ).toThrow();
  expect(load({ DATABASE_URL: "postgres://localhost/db" })).toMatchObject({
    mode: "real",
    secureCookies: true,
  });
  expect(() =>
    load({ DATABASE_URL: "postgres://localhost/db", SECURE_COOKIES: "false" }),
  ).toThrow();
  expect(load({ ZKISS_MODE: "demo" })).toMatchObject({
    mode: "demo",
    host: "127.0.0.1",
  });
});

test("Render's public HTTPS origin is used when an explicit origin is absent", () => {
  expect(
    config.loadConfig({
      DATABASE_URL: "postgres://localhost/db",
      RENDER_EXTERNAL_URL: "https://zkiss-demo.onrender.com",
    }).origin,
  ).toBe("https://zkiss-demo.onrender.com");
});
