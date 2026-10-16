import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  OPENAI_FREE_DAILY_PRESET,
  ProviderDriverKind,
  ProviderInstanceId,
  UsagePolicyId,
  type UsagePolicy,
} from "@t3tools/contracts";
import { emptyTokenCounts } from "@t3tools/shared/usagePolicies";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProviderUsageDaily from "../persistence/ProviderUsageDaily.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as UsagePolicyService from "./UsagePolicyService.ts";

const codexInstanceId = ProviderInstanceId.make("codex");
const codexBInstanceId = ProviderInstanceId.make("codex-b");
const codexDriver = ProviderDriverKind.make("codex");

const tinyPolicy = (overrides: Partial<UsagePolicy> = {}): UsagePolicy => ({
  id: UsagePolicyId.make("tiny"),
  scope: { driverKind: codexDriver },
  resetTimezone: "UTC",
  period: "day",
  groups: [
    { id: "standard", models: ["gpt-5.4"], maxTokens: 1_000, stopAtRatio: 0.9 },
    { id: "mini", models: ["gpt-5.4-mini"], maxTokens: 10_000, stopAtRatio: 0.9 },
  ],
  allowlist: "groups",
  onExceeded: "block",
  authModes: ["apiKey"],
  ...overrides,
});

const makeSettingsLayer = (policies: Record<string, UsagePolicy>) =>
  Layer.mock(ServerSettings.ServerSettingsService)({
    getSettings: Effect.succeed({
      ...DEFAULT_SERVER_SETTINGS,
      usagePolicies: policies,
    }),
  });

const makeRegistryLayer = (
  instances: ReadonlyArray<{
    readonly instanceId: ProviderInstanceId;
    readonly driverKind: typeof codexDriver;
    readonly authType: string;
  }>,
) =>
  Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
    getInstance: (instanceId) =>
      Effect.succeed(
        (() => {
          const found = instances.find((entry) => entry.instanceId === instanceId);
          if (found === undefined) return undefined;
          return {
            instanceId: found.instanceId,
            driverKind: found.driverKind,
            snapshot: {
              getSnapshot: Effect.succeed({ auth: { type: found.authType } }),
            },
          } as never;
        })(),
      ),
    listInstances: Effect.succeed(
      instances.map(
        (found) =>
          ({
            instanceId: found.instanceId,
            driverKind: found.driverKind,
            snapshot: {
              getSnapshot: Effect.succeed({ auth: { type: found.authType } }),
            },
          }) as never,
      ),
    ),
  });

const makeServiceLayer = (input: {
  readonly policies: Record<string, UsagePolicy>;
  readonly instances?: ReadonlyArray<{
    readonly instanceId: ProviderInstanceId;
    readonly driverKind: typeof codexDriver;
    readonly authType: string;
  }>;
}) =>
  Layer.merge(
    UsagePolicyService.layer.pipe(
      Layer.provide(ProviderUsageDaily.layer),
      Layer.provide(makeSettingsLayer(input.policies)),
      Layer.provide(SqlitePersistence.layerMemory),
    ),
    // Registry is looked up per call via serviceOption; merge it into the
    // runtime context (providing it into a layer that no longer requires it
    // would discard it).
    makeRegistryLayer(
      input.instances ?? [
        { instanceId: codexInstanceId, driverKind: codexDriver, authType: "apiKey" },
      ],
    ),
  );

describe("UsagePolicyService", () => {
  it.effect(
    "marks the status estimated after a chars/4 projection until real usage is recorded",
    () =>
      Effect.gen(function* () {
        const service = yield* UsagePolicyService.UsagePolicyService;
        const day = "2026-10-15";
        assert.strictEqual((yield* service.status).estimated, undefined);
        yield* service.evaluate({
          instanceId: codexInstanceId,
          driverKind: codexDriver,
          model: "gpt-5.4",
          authType: "apiKey",
          day,
          projectedAdditionalTokens: 10,
          projectionEstimated: true,
        });
        assert.strictEqual((yield* service.status).estimated, true);
        yield* service.record({
          instanceId: codexInstanceId,
          driverKind: codexDriver,
          model: "gpt-5.4",
          authType: "apiKey",
          day,
          delta: { ...emptyTokenCounts(), inputTokens: 5 },
        });
        assert.strictEqual((yield* service.status).estimated, undefined);
      }).pipe(Effect.provide(makeServiceLayer({ policies: { tiny: tinyPolicy() } }))),
  );

  it.effect("allows when no policies are configured", () =>
    Effect.gen(function* () {
      const service = yield* UsagePolicyService.UsagePolicyService;
      const result = yield* service.evaluate({
        instanceId: codexInstanceId,
        driverKind: codexDriver,
        model: "gpt-5.4",
        authType: "apiKey",
      });
      assert.strictEqual(result.decision, "allow");
    }).pipe(Effect.provide(makeServiceLayer({ policies: {} }))),
  );

  it.effect("blocks disallowed models pre-turn", () =>
    Effect.gen(function* () {
      const service = yield* UsagePolicyService.UsagePolicyService;
      const result = yield* service.evaluate({
        instanceId: codexInstanceId,
        driverKind: codexDriver,
        model: "gpt-image-1",
        authType: "apiKey",
        day: "2026-10-15",
      });
      assert.strictEqual(result.decision, "block_model");
    }).pipe(Effect.provide(makeServiceLayer({ policies: { tiny: tinyPolicy() } }))),
  );

  it.effect("records deltas and blocks at hard cap; day rollover resets", () =>
    Effect.gen(function* () {
      const service = yield* UsagePolicyService.UsagePolicyService;
      const day = "2026-10-15";
      yield* service.record({
        instanceId: codexInstanceId,
        driverKind: codexDriver,
        model: "gpt-5.4",
        authType: "apiKey",
        day,
        delta: { ...emptyTokenCounts(), inputTokens: 900, outputTokens: 0 },
      });
      const soft = yield* service.evaluate({
        instanceId: codexInstanceId,
        driverKind: codexDriver,
        model: "gpt-5.4",
        authType: "apiKey",
        day,
        midTurn: true,
      });
      assert.strictEqual(soft.decision, "interrupt_cap");

      yield* service.record({
        instanceId: codexInstanceId,
        driverKind: codexDriver,
        model: "gpt-5.4",
        authType: "apiKey",
        day,
        delta: { ...emptyTokenCounts(), inputTokens: 100, outputTokens: 0 },
      });
      const hard = yield* service.evaluate({
        instanceId: codexInstanceId,
        driverKind: codexDriver,
        model: "gpt-5.4",
        authType: "apiKey",
        day,
      });
      assert.strictEqual(hard.decision, "block_cap");

      const nextDay = yield* service.evaluate({
        instanceId: codexInstanceId,
        driverKind: codexDriver,
        model: "gpt-5.4",
        authType: "apiKey",
        day: "2026-10-16",
      });
      assert.strictEqual(nextDay.decision, "allow");
    }).pipe(Effect.provide(makeServiceLayer({ policies: { tiny: tinyPolicy() } }))),
  );

  it.effect("warn mode returns warn_cap instead of block_cap", () =>
    Effect.gen(function* () {
      const service = yield* UsagePolicyService.UsagePolicyService;
      const day = "2026-10-15";
      yield* service.record({
        instanceId: codexInstanceId,
        driverKind: codexDriver,
        model: "gpt-5.4",
        authType: "apiKey",
        day,
        delta: { ...emptyTokenCounts(), inputTokens: 1_000 },
      });
      const result = yield* service.evaluate({
        instanceId: codexInstanceId,
        driverKind: codexDriver,
        model: "gpt-5.4",
        authType: "apiKey",
        day,
      });
      assert.strictEqual(result.decision, "warn_cap");
    }).pipe(
      Effect.provide(makeServiceLayer({ policies: { tiny: tinyPolicy({ onExceeded: "warn" }) } })),
    ),
  );

  it.effect("skips chatgpt auth when policy is apiKey-only", () =>
    Effect.gen(function* () {
      const service = yield* UsagePolicyService.UsagePolicyService;
      const result = yield* service.evaluate({
        instanceId: codexInstanceId,
        driverKind: codexDriver,
        model: "gpt-5.4",
        authType: "chatgpt",
        day: "2026-10-15",
      });
      assert.strictEqual(result.decision, "allow");
    }).pipe(
      Effect.provide(
        makeServiceLayer({
          policies: { "openai-free-daily": OPENAI_FREE_DAILY_PRESET },
        }),
      ),
    ),
  );

  it.effect("keeps counters separate per instance when scoped", () =>
    Effect.gen(function* () {
      const service = yield* UsagePolicyService.UsagePolicyService;
      const day = "2026-10-15";
      // instead record on A and evaluate B under a global policy that scopes by instance.
      yield* service.record({
        instanceId: codexInstanceId,
        driverKind: codexDriver,
        model: "gpt-5.4",
        authType: "apiKey",
        day,
        delta: { ...emptyTokenCounts(), inputTokens: 1_000 },
      });
      const blockedA = yield* service.evaluate({
        instanceId: codexInstanceId,
        driverKind: codexDriver,
        model: "gpt-5.4",
        authType: "apiKey",
        day,
      });
      assert.strictEqual(blockedA.decision, "block_cap");

      const openB = yield* service.evaluate({
        instanceId: codexBInstanceId,
        driverKind: codexDriver,
        model: "gpt-5.4",
        authType: "apiKey",
        day,
      });
      // Global driver-scoped policy still applies to B with empty counter.
      assert.strictEqual(openB.decision, "allow");
    }).pipe(
      Effect.provide(
        makeServiceLayer({
          policies: { tiny: tinyPolicy() },
          instances: [
            { instanceId: codexInstanceId, driverKind: codexDriver, authType: "apiKey" },
            { instanceId: codexBInstanceId, driverKind: codexDriver, authType: "apiKey" },
          ],
        }),
      ),
    ),
  );

  it.effect("record mid-turn returns interrupt_cap after soft stop", () =>
    Effect.gen(function* () {
      const service = yield* UsagePolicyService.UsagePolicyService;
      const day = "2026-10-15";
      const first = yield* service.record({
        instanceId: codexInstanceId,
        driverKind: codexDriver,
        model: "gpt-5.4-2025-04-14",
        authType: "apiKey",
        day,
        delta: { ...emptyTokenCounts(), inputTokens: 450, outputTokens: 450 },
      });
      assert.strictEqual(first.decision, "interrupt_cap");
    }).pipe(Effect.provide(makeServiceLayer({ policies: { tiny: tinyPolicy() } }))),
  );

  it.effect("status aggregates group usage across matching instances", () =>
    Effect.gen(function* () {
      const service = yield* UsagePolicyService.UsagePolicyService;
      // status uses utcDayKey() — record without overriding day so it matches.
      yield* service.record({
        instanceId: codexInstanceId,
        driverKind: codexDriver,
        model: "gpt-5.4",
        authType: "apiKey",
        delta: { ...emptyTokenCounts(), inputTokens: 40, outputTokens: 10 },
      });
      const status = yield* service.status;
      assert.ok(status.policies.length >= 1);
      const entry = status.policies[0];
      assert.ok(entry !== undefined);
      const standard = entry.groups.find((group) => group.groupId === "standard");
      assert.ok(standard !== undefined);
      assert.strictEqual(standard.usedTokens, 50);
      assert.strictEqual(standard.maxTokens, 1_000);
      assert.ok(status.resetsAt.endsWith("T00:00:00.000Z"));
      assert.ok(status.resetsAt.startsWith(status.day.slice(0, 8)) || status.resetsAt > status.day);
    }).pipe(Effect.provide(makeServiceLayer({ policies: { tiny: tinyPolicy() } }))),
  );
});
