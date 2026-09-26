import { runtime } from "./runtime.js";
import { migrate } from "./db.js";
const { config, pool } = runtime();
try {
  const command = process.argv[2];
  if (command === "migrate") {
    await migrate(pool);
    console.log("Migrations applied.");
  } else if (command === "seed-demo") {
    if (config.mode !== "demo") throw new Error("DEMO_ONLY");
    await pool.query(
      `INSERT INTO events(id,name,join_until,discover_until,chat_until,modes,sns_reveal) VALUES('evt_demo','ZKiss 로컬 데모',now()+interval '1 day',now()+interval '1 day',now()+interval '2 days','["mutual_like","question_reply"]',true) ON CONFLICT(id) DO NOTHING`,
    );
    await pool.query(
      "UPDATE events SET midnight_network='demo',midnight_contract_address=$1,midnight_event_scope=$2 WHERE id='evt_demo' AND midnight_contract_address IS NULL",
      ["a".repeat(64), "b".repeat(64)],
    );
    console.log("Demo event evt_demo ready (existing dates preserved).");
  } else throw new Error("UNKNOWN_COMMAND");
} catch {
  console.error("CLI_FAILED: check mode, database and command.");
  process.exitCode = 1;
} finally {
  await pool.end();
}
