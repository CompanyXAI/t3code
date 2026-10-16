import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import {
  NonNegativeInt,
  ProviderDriverKind,
  ProviderInstanceId,
  TrimmedNonEmptyString,
  type UsageTokenCounts,
} from "@t3tools/contracts";

import {
  PersistenceDecodeError,
  PersistenceSqlError,
  type ProviderUsageDailyRepositoryError,
} from "./Errors.ts";

const UsageDayRow = Schema.Struct({
  day: TrimmedNonEmptyString,
  instance_id: ProviderInstanceId,
  driver: ProviderDriverKind,
  model: TrimmedNonEmptyString,
  group_id: TrimmedNonEmptyString,
  input_tokens: NonNegativeInt,
  cached_input_tokens: NonNegativeInt,
  cache_creation_tokens: NonNegativeInt,
  output_tokens: NonNegativeInt,
  reasoning_tokens: NonNegativeInt,
  total_tokens: NonNegativeInt,
  updated_at: TrimmedNonEmptyString,
});

export interface ProviderUsageDailyKey {
  readonly day: string;
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly model: string;
  readonly groupId: string;
}

export interface ProviderUsageDailyRow extends ProviderUsageDailyKey {
  readonly counts: UsageTokenCounts;
  readonly totalTokens: number;
  readonly updatedAt: string;
}

export class ProviderUsageDailyRepository extends Context.Service<
  ProviderUsageDailyRepository,
  {
    readonly upsertDelta: (
      key: ProviderUsageDailyKey,
      delta: UsageTokenCounts,
      updatedAtIso: string,
    ) => Effect.Effect<void, ProviderUsageDailyRepositoryError>;
    readonly listForDayInstance: (input: {
      readonly day: string;
      readonly instanceId: ProviderInstanceId;
    }) => Effect.Effect<ReadonlyArray<ProviderUsageDailyRow>, ProviderUsageDailyRepositoryError>;
    readonly sumGroupTokens: (input: {
      readonly day: string;
      readonly instanceId: ProviderInstanceId;
      readonly groupId: string;
    }) => Effect.Effect<number, ProviderUsageDailyRepositoryError>;
  }
>()("t3/persistence/ProviderUsageDaily/ProviderUsageDailyRepository") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const listRows = SqlSchema.findAll({
    Request: Schema.Struct({
      day: TrimmedNonEmptyString,
      instanceId: ProviderInstanceId,
    }),
    Result: UsageDayRow,
    execute: ({ day, instanceId }) =>
      sql`
        SELECT
          day,
          instance_id,
          driver,
          model,
          group_id,
          input_tokens,
          cached_input_tokens,
          cache_creation_tokens,
          output_tokens,
          reasoning_tokens,
          total_tokens,
          updated_at
        FROM provider_usage_daily
        WHERE day = ${day} AND instance_id = ${instanceId}
      `,
  });

  const sumGroup = SqlSchema.findOne({
    Request: Schema.Struct({
      day: TrimmedNonEmptyString,
      instanceId: ProviderInstanceId,
      groupId: TrimmedNonEmptyString,
    }),
    Result: Schema.Struct({ total: NonNegativeInt }),
    execute: ({ day, instanceId, groupId }) =>
      sql`
        SELECT COALESCE(SUM(total_tokens), 0) AS "total"
        FROM provider_usage_daily
        WHERE day = ${day} AND instance_id = ${instanceId} AND group_id = ${groupId}
      `,
  });

  return ProviderUsageDailyRepository.of({
    upsertDelta: (key, delta, updatedAtIso) => {
      const total =
        delta.inputTokens + delta.outputTokens;
      return sql`
        INSERT INTO provider_usage_daily (
          day, instance_id, driver, model, group_id,
          input_tokens, cached_input_tokens, cache_creation_tokens,
          output_tokens, reasoning_tokens, total_tokens, updated_at
        ) VALUES (
          ${key.day}, ${key.instanceId}, ${key.driver}, ${key.model}, ${key.groupId},
          ${delta.inputTokens}, ${delta.cachedInputTokens}, ${delta.cacheCreationTokens},
          ${delta.outputTokens}, ${delta.reasoningTokens}, ${total}, ${updatedAtIso}
        )
        ON CONFLICT (day, instance_id, driver, model, group_id) DO UPDATE SET
          input_tokens = input_tokens + excluded.input_tokens,
          cached_input_tokens = cached_input_tokens + excluded.cached_input_tokens,
          cache_creation_tokens = cache_creation_tokens + excluded.cache_creation_tokens,
          output_tokens = output_tokens + excluded.output_tokens,
          reasoning_tokens = reasoning_tokens + excluded.reasoning_tokens,
          total_tokens = total_tokens + excluded.total_tokens,
          updated_at = excluded.updated_at
      `.pipe(
        Effect.asVoid,
        Effect.mapError(
          (cause) => new PersistenceSqlError({ operation: "upsertProviderUsageDaily", cause }),
        ),
      );
    },
    listForDayInstance: (input) =>
      listRows(input).pipe(
        Effect.map((rows) =>
          rows.map((row) => ({
            day: row.day,
            instanceId: row.instance_id,
            driver: row.driver,
            model: row.model,
            groupId: row.group_id,
            counts: {
              inputTokens: row.input_tokens,
              cachedInputTokens: row.cached_input_tokens,
              cacheCreationTokens: row.cache_creation_tokens,
              outputTokens: row.output_tokens,
              reasoningTokens: row.reasoning_tokens,
            },
            totalTokens: row.total_tokens,
            updatedAt: row.updated_at,
          })),
        ),
        Effect.mapError((cause) =>
          Schema.isSchemaError(cause)
            ? PersistenceDecodeError.fromSchemaError("listProviderUsageDaily", cause)
            : new PersistenceSqlError({ operation: "listProviderUsageDaily", cause }),
        ),
      ),
    sumGroupTokens: (input) =>
      sumGroup(input).pipe(
        Effect.map((row) => row.total),
        Effect.mapError((cause) =>
          Schema.isSchemaError(cause)
            ? PersistenceDecodeError.fromSchemaError("sumProviderUsageDailyGroup", cause)
            : new PersistenceSqlError({ operation: "sumProviderUsageDailyGroup", cause }),
        ),
      ),
  });
});

export const layer = Layer.effect(ProviderUsageDailyRepository, make);
