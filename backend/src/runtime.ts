import { existsSync } from "node:fs";
import { Pool, type PoolConfig } from "pg";
import { loadConfig, type Config } from "./config.js";
export function poolOptions(config: Config, env: NodeJS.ProcessEnv = process.env): PoolConfig {
  const ca = env.DATABASE_CA_PEM?.replaceAll("\\n", "\n");
  const url = ca ? new URL(config.databaseUrl) : undefined;
  if (url) {
    url.searchParams.delete("sslmode");
    url.searchParams.delete("sslrootcert");
  }
  return {
    connectionString: url?.toString() ?? config.databaseUrl,
    ...(ca ? { ssl: { ca, rejectUnauthorized: true } } : {}),
    max: 10,
    connectionTimeoutMillis: 30000,
    idleTimeoutMillis: 30000,
    statement_timeout: 45000,
    idle_in_transaction_session_timeout: 45000,
  };
}
export function runtime() {
  if (existsSync(".env")) process.loadEnvFile(".env");
  const config = loadConfig();
  const pool = new Pool(poolOptions(config));
  pool.on("error", () =>
    console.error(JSON.stringify({ code: "DATABASE_CONNECTION_ERROR" })),
  );
  // Pool "error" only covers idle clients. A checked-out client (relay advisory lock,
  // chain job lane) that loses its connection would otherwise crash the process;
  // its pending query still rejects, so the request fails without taking the API down.
  pool.on("connect", (client) =>
    client.on("error", () =>
      console.error(JSON.stringify({ code: "DATABASE_CLIENT_ERROR" })),
    ),
  );
  return { config, pool };
}
