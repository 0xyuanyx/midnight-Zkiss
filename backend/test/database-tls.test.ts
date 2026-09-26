import { test, expect } from "vitest";
import { poolOptions } from "../src/runtime.js";
import { localConfig } from "../src/config.js";

test("deployed Supabase connection uses the supplied CA and verifies the server", () => {
  const options = poolOptions(
    { ...localConfig, databaseUrl: "postgres://user:pass@db.example.com/db?sslmode=verify-full&sslrootcert=/local/only.pem" },
    { DATABASE_CA_PEM: "-----BEGIN CERTIFICATE-----\\ncertificate\\n-----END CERTIFICATE-----" },
  );
  expect(options.connectionString).not.toContain("sslrootcert");
  expect(options.ssl).toEqual({
    rejectUnauthorized: true,
    ca: "-----BEGIN CERTIFICATE-----\ncertificate\n-----END CERTIFICATE-----",
  });
});
