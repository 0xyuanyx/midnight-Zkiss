import { runtime } from "./runtime.js";
import { loadProviders } from "./providers.js";
import { buildApp } from "./app.js";
const { config, pool } = runtime();
try {
  await pool.query("SELECT version FROM migrations LIMIT 1");
  const app = await buildApp({
    pool,
    config,
    ...(await loadProviders(config)),
  });
  const stop = async () => {
    await app.close();
    await pool.end();
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
  await app.listen({ host: config.host, port: config.port });
  console.log(
    JSON.stringify({
      status: "listening",
      mode: config.mode,
      host: config.host,
      port: config.port,
    }),
  );
} catch {
  console.error(
    JSON.stringify({
      code: "STARTUP_FAILED",
      hint: "Check configuration, migrations and provider modules.",
    }),
  );
  await pool.end();
  process.exitCode = 1;
}
