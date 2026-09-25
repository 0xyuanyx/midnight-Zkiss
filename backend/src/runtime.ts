import { existsSync } from "node:fs";
import { Pool } from "pg";
import { loadConfig } from "./config.js";
export function runtime() {
  if (existsSync(".env")) process.loadEnvFile(".env");
  const config = loadConfig();
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: 10,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    statement_timeout: 45000,
    idle_in_transaction_session_timeout: 45000,
  });
  pool.on("error", () =>
    console.error(JSON.stringify({ code: "DATABASE_CONNECTION_ERROR" })),
  );
  return { config, pool };
}
