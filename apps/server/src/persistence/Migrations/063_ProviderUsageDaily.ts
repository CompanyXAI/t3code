import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Per UTC day, per instance/driver/model/group token counters for T3 usage
  // policies. Upserted as deltas from provider turn usage events.
  yield* sql`
    CREATE TABLE IF NOT EXISTS provider_usage_daily (
      day TEXT NOT NULL,
      instance_id TEXT NOT NULL,
      driver TEXT NOT NULL,
      model TEXT NOT NULL,
      group_id TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      cached_input_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (day, instance_id, driver, model, group_id)
    ) WITHOUT ROWID
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS provider_usage_daily_day_instance_group_idx
    ON provider_usage_daily(day, instance_id, group_id)
  `;
});
