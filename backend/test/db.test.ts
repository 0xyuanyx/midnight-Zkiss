import { test, expect } from "vitest";
import { database } from "./helpers.js";
import { migrate } from "../src/db.js";
test("migration is repeatable and events survive a new database connection", async () => {
  const db = await database();
  try {
    await migrate(db.pool);
    await migrate(db.pool);
    const result = await db.pool
      .query(
        "INSERT INTO events(id,name,join_until,discover_until,chat_until) VALUES('evt','Event',now()+interval '1 day',now()+interval '1 day',now()+interval '2 days') RETURNING id",
      )
      .catch((e) => ({ rows: [], code: e.code }));
    expect(result.rows).toEqual([{ id: "evt" }]);
    const client = await db.pool.connect();
    try {
      expect((await client.query("SELECT name FROM events")).rows).toEqual([
        { name: "Event" },
      ]);
    } finally {
      client.release();
    }
  } finally {
    await db.close();
  }
});
