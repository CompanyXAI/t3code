import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProviderUsageDaily from "./ProviderUsageDaily.ts";
import * as SqlitePersistence from "./Sqlite.ts";
import { emptyTokenCounts } from "@t3tools/shared/usagePolicies";

const layer = ProviderUsageDaily.layer.pipe(Layer.provide(SqlitePersistence.layerMemory));

describe("ProviderUsageDailyRepository", () => {
  it.effect("upserts deltas and sums by group", () =>
    Effect.gen(function* () {
      const repo = yield* ProviderUsageDaily.ProviderUsageDailyRepository;
      const instanceId = ProviderInstanceId.make("codex");
      const driver = ProviderDriverKind.make("codex");
      yield* repo.upsertDelta(
        {
          day: "2026-10-15",
          instanceId,
          driver,
          model: "gpt-5.4",
          groupId: "openai-free-daily:standard",
        },
        { ...emptyTokenCounts(), inputTokens: 100_000, outputTokens: 20_000 },
        "2026-10-15T12:00:00.000Z",
      );
      yield* repo.upsertDelta(
        {
          day: "2026-10-15",
          instanceId,
          driver,
          model: "gpt-5.4",
          groupId: "openai-free-daily:standard",
        },
        { ...emptyTokenCounts(), inputTokens: 50_000 },
        "2026-10-15T13:00:00.000Z",
      );
      const total = yield* repo.sumGroupTokens({
        day: "2026-10-15",
        instanceId,
        groupId: "openai-free-daily:standard",
      });
      assert.strictEqual(total, 170_000);

      const nextDay = yield* repo.sumGroupTokens({
        day: "2026-10-16",
        instanceId,
        groupId: "openai-free-daily:standard",
      });
      assert.strictEqual(nextDay, 0);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("keeps model rows and group sums isolated across instances", () =>
    Effect.gen(function* () {
      const repo = yield* ProviderUsageDaily.ProviderUsageDailyRepository;
      const a = ProviderInstanceId.make("codex");
      const b = ProviderInstanceId.make("codex-b");
      const driver = ProviderDriverKind.make("codex");
      yield* repo.upsertDelta(
        {
          day: "2026-10-15",
          instanceId: a,
          driver,
          model: "gpt-5.4",
          groupId: "openai-free-daily:standard",
        },
        { ...emptyTokenCounts(), inputTokens: 10_000 },
        "2026-10-15T12:00:00.000Z",
      );
      yield* repo.upsertDelta(
        {
          day: "2026-10-15",
          instanceId: b,
          driver,
          model: "gpt-5.4",
          groupId: "openai-free-daily:standard",
        },
        { ...emptyTokenCounts(), inputTokens: 3_000 },
        "2026-10-15T12:00:00.000Z",
      );
      const sumA = yield* repo.sumGroupTokens({
        day: "2026-10-15",
        instanceId: a,
        groupId: "openai-free-daily:standard",
      });
      const sumB = yield* repo.sumGroupTokens({
        day: "2026-10-15",
        instanceId: b,
        groupId: "openai-free-daily:standard",
      });
      assert.strictEqual(sumA, 10_000);
      assert.strictEqual(sumB, 3_000);
      const rowsA = yield* repo.listForDayInstance({ day: "2026-10-15", instanceId: a });
      assert.strictEqual(rowsA.length, 1);
      assert.strictEqual(rowsA[0]?.model, "gpt-5.4");
    }).pipe(Effect.provide(layer)),
  );
});
