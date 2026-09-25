import { demoMidnight, createDemoOperator } from "./adapters/demo-midnight.js";
import { setTimeout as delay } from "node:timers/promises";
import { runtime } from "./runtime.js";
import { loadProviders, loadOperator } from "./providers.js";
import { maintain, reconcile, processChainJobs } from "./worker.js";
const { config, pool } = runtime();
let stopped = false;
const abort = new AbortController();
const stop = () => {
  stopped = true;
  abort.abort();
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
try {
  const providers = await loadProviders(config);
  const midnight =
    providers.midnight ?? (config.mode === "demo" ? demoMidnight : undefined);
  const operator =
    (await loadOperator(config)) ??
    (config.mode === "demo" ? createDemoOperator() : undefined);
  console.log(
    JSON.stringify({
      status: "worker_started",
      mode: config.mode,
      chainVerification: !!midnight,
    }),
  );
  while (!stopped) {
    try {
      await maintain(pool);
      if (midnight) await reconcile(pool, midnight);
      if (midnight && operator)
        await processChainJobs(pool, midnight, operator);
    } catch {
      console.error(JSON.stringify({ code: "WORKER_TICK_FAILED" }));
    }
    if (process.argv.includes("--once")) break;
    if (!stopped)
      await delay(1500, undefined, { signal: abort.signal }).catch(() => {});
  }
} catch {
  console.error(JSON.stringify({ code: "WORKER_STARTUP_FAILED" }));
  process.exitCode = 1;
} finally {
  await pool.end();
}
