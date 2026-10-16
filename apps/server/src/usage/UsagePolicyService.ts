/**
 * UsagePolicyService — evaluates and records T3-enforced daily token policies.
 *
 * Policies live in `ServerSettings.usagePolicies`. Token deltas are upserted
 * into `provider_usage_daily` and re-evaluated before turns and mid-turn for
 * providers that stream usage (Codex today).
 *
 * @module usage/UsagePolicyService
 */
import {
  type ProviderDriverKind,
  type ProviderInstanceId,
  type UsagePolicy,
  type UsagePolicyEvaluation,
  type UsagePolicyGroupUsage,
  type UsagePolicyStatus,
  type UsageTokenCounts,
} from "@t3tools/contracts";
import {
  evaluateUsagePolicies,
  findGroupForModel,
  groupUsageFromTotals,
  normalizeUsageModelId,
  policyAppliesToAuthMode,
  policyAppliesToInstance,
  resolveUsageAuthMode,
  totalTokensFromCounts,
  utcDayKey,
  utcDayResetsAtIso,
} from "@t3tools/shared/usagePolicies";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ProviderUsageDaily from "../persistence/ProviderUsageDaily.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import { subscribeBeforeSnapshot } from "../utils/subscribeBeforeSnapshot.ts";

export interface UsagePolicyEvaluateInput {
  readonly instanceId: ProviderInstanceId;
  readonly driverKind: ProviderDriverKind;
  readonly model: string;
  readonly authType?: string | null;
  readonly midTurn?: boolean;
  readonly day?: string;
  /**
   * Extra tokens projected for this turn. Used for providers without live
   * usage events (via `estimateHandoffContextTokens`); real recorded usage
   * stays primary.
   */
  readonly projectedAdditionalTokens?: number;
  /** The projection came from chars/4 (no reported context); drives the UI "estimated" badge. */
  readonly projectionEstimated?: boolean;
}

export interface UsagePolicyRecordInput {
  readonly instanceId: ProviderInstanceId;
  readonly driverKind: ProviderDriverKind;
  readonly model: string;
  readonly authType?: string | null;
  readonly delta: UsageTokenCounts;
  readonly day?: string;
}

export class UsagePolicyService extends Context.Service<
  UsagePolicyService,
  {
    readonly evaluate: (input: UsagePolicyEvaluateInput) => Effect.Effect<UsagePolicyEvaluation>;
    readonly record: (input: UsagePolicyRecordInput) => Effect.Effect<UsagePolicyEvaluation>;
    readonly status: Effect.Effect<UsagePolicyStatus>;
    readonly subscribe: Effect.Effect<
      {
        readonly latest: UsagePolicyStatus;
        readonly changes: Stream.Stream<UsagePolicyStatus>;
      },
      never,
      Scope.Scope
    >;
  }
>()("t3/usage/UsagePolicyService") {}

function policiesFromSettings(settings: {
  readonly usagePolicies: Readonly<Record<string, UsagePolicy>>;
}): ReadonlyArray<UsagePolicy> {
  return Object.values(settings.usagePolicies);
}

const make = Effect.gen(function* () {
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const usageDaily = yield* ProviderUsageDaily.ProviderUsageDailyRepository;
  const changes = yield* PubSub.unbounded<UsagePolicyStatus>();
  const publishMutex = yield* Semaphore.make(1);
  // Whether the latest pre-turn projection was a chars/4 estimate. Real
  // recorded usage clears it.
  let projectionEstimated = false;

  // Look up the registry per call (caller context), not at layer build time —
  // requiring it on this layer races provideMerge order and crashes boot.
  const resolveRegistry = Effect.serviceOption(ProviderInstanceRegistry.ProviderInstanceRegistry);

  const resolveAuthType = Effect.fn("UsagePolicyService.resolveAuthType")(function* (
    instanceId: ProviderInstanceId,
    explicit: string | null | undefined,
  ) {
    if (explicit !== undefined && explicit !== null && explicit !== "") return explicit;
    const providerInstances = yield* resolveRegistry;
    if (Option.isNone(providerInstances)) return undefined;
    const instance = yield* providerInstances.value.getInstance(instanceId);
    if (instance === undefined) return undefined;
    const snapshot = yield* instance.snapshot.getSnapshot;
    return snapshot.auth.type;
  });

  const usedTokensByGroupForInstance = Effect.fn("UsagePolicyService.usedTokensByGroup")(
    function* (input: {
      readonly day: string;
      readonly instanceId: ProviderInstanceId;
      readonly policies: ReadonlyArray<UsagePolicy>;
      readonly driverKind: ProviderDriverKind;
      readonly authMode: ReturnType<typeof resolveUsageAuthMode>;
    }) {
      const map = new Map<string, number>();
      for (const policy of input.policies) {
        if (!policyAppliesToInstance(policy, input)) continue;
        if (!policyAppliesToAuthMode(policy, input.authMode)) continue;
        for (const group of policy.groups) {
          const used = yield* usageDaily
            .sumGroupTokens({
              day: input.day,
              instanceId: input.instanceId,
              groupId: `${policy.id}:${group.id}`,
            })
            .pipe(Effect.orDie);
          map.set(`${policy.id}:${group.id}`, used);
        }
      }
      return map;
    },
  );

  const buildStatus = Effect.fn("UsagePolicyService.buildStatus")(function* () {
    const settings = yield* settingsService.getSettings.pipe(Effect.orDie);
    const day = utcDayKey(yield* DateTime.now);
    const policies = policiesFromSettings(settings);
    const entries: Array<{
      readonly policy: UsagePolicy;
      readonly groups: ReadonlyArray<UsagePolicyGroupUsage>;
    }> = [];

    for (const policy of policies) {
      // Aggregate group usage across every instance the policy can hit. For a
      // scoped policy that is one instance; for a global policy it is all of
      // them that share the group key prefix.
      const groups: UsagePolicyGroupUsage[] = [];
      for (const group of policy.groups) {
        let used = 0;
        const providerInstances = yield* resolveRegistry;
        const instances = Option.isSome(providerInstances)
          ? yield* providerInstances.value.listInstances
          : [];
        for (const instance of instances) {
          if (
            !policyAppliesToInstance(policy, {
              instanceId: instance.instanceId,
              driverKind: instance.driverKind,
            })
          ) {
            continue;
          }
          used += yield* usageDaily
            .sumGroupTokens({
              day,
              instanceId: instance.instanceId,
              groupId: `${policy.id}:${group.id}`,
            })
            .pipe(Effect.orDie);
        }
        groups.push(groupUsageFromTotals(group, used));
      }
      entries.push({ policy, groups });
    }

    return {
      day,
      resetsAt: utcDayResetsAtIso(day),
      ...(projectionEstimated ? { estimated: true } : {}),
      policies: entries,
    } satisfies UsagePolicyStatus;
  });

  const publishStatus = Effect.fn("UsagePolicyService.publishStatus")(function* () {
    const status = yield* buildStatus();
    yield* PubSub.publish(changes, status);
    return status;
  });

  const evaluate = Effect.fn("UsagePolicyService.evaluate")(function* (
    input: UsagePolicyEvaluateInput,
  ) {
    const settings = yield* settingsService.getSettings.pipe(Effect.orDie);
    const policies = policiesFromSettings(settings);
    if (input.midTurn !== true && input.projectionEstimated !== undefined) {
      const next = input.projectionEstimated;
      if (next !== projectionEstimated) {
        projectionEstimated = next;
        if (policies.length > 0) yield* publishStatus().pipe(Effect.ignore);
      }
    }
    if (policies.length === 0) {
      return { decision: "allow" as const, groups: [] };
    }
    const authType = yield* resolveAuthType(input.instanceId, input.authType);
    const authMode = resolveUsageAuthMode(authType);
    const day = input.day ?? utcDayKey(yield* DateTime.now);
    const usedTokensByGroup = yield* usedTokensByGroupForInstance({
      day,
      instanceId: input.instanceId,
      policies,
      driverKind: input.driverKind,
      authMode,
    });
    return evaluateUsagePolicies({
      policies,
      instanceId: input.instanceId,
      driverKind: input.driverKind,
      authMode,
      model: input.model,
      usedTokensByGroup,
      midTurn: input.midTurn === true,
      projectedAdditionalTokens: input.projectedAdditionalTokens ?? 0,
    });
  });

  const record = Effect.fn("UsagePolicyService.record")(function* (input: UsagePolicyRecordInput) {
    const settings = yield* settingsService.getSettings.pipe(Effect.orDie);
    const policies = policiesFromSettings(settings);
    const authType = yield* resolveAuthType(input.instanceId, input.authType);
    const authMode = resolveUsageAuthMode(authType);
    const day = input.day ?? utcDayKey(yield* DateTime.now);
    const model = normalizeUsageModelId(input.model);
    const now = yield* DateTime.now;
    const updatedAtIso = DateTime.formatIso(now);

    let recorded = false;
    for (const policy of policies) {
      if (
        !policyAppliesToInstance(policy, {
          instanceId: input.instanceId,
          driverKind: input.driverKind,
        })
      ) {
        continue;
      }
      if (!policyAppliesToAuthMode(policy, authMode)) continue;
      const group = findGroupForModel(policy, model);
      if (group === undefined) continue;
      if (totalTokensFromCounts(input.delta) <= 0) continue;
      yield* usageDaily
        .upsertDelta(
          {
            day,
            instanceId: input.instanceId,
            driver: input.driverKind,
            model,
            groupId: `${policy.id}:${group.id}`,
          },
          input.delta,
          updatedAtIso,
        )
        .pipe(Effect.orDie);
      recorded = true;
    }

    if (recorded) {
      projectionEstimated = false;
      yield* publishStatus().pipe(Effect.ignore);
    }

    return yield* evaluate({
      instanceId: input.instanceId,
      driverKind: input.driverKind,
      model: input.model,
      ...(authType !== undefined ? { authType } : {}),
      midTurn: true,
      day,
    });
  });

  return UsagePolicyService.of({
    evaluate,
    record,
    status: buildStatus(),
    subscribe: subscribeBeforeSnapshot(changes, buildStatus(), publishMutex),
  });
});

export const layer: Layer.Layer<
  UsagePolicyService,
  never,
  ServerSettings.ServerSettingsService | ProviderUsageDaily.ProviderUsageDailyRepository
> = Layer.effect(UsagePolicyService, make);

/** No-op layer for orchestration tests that do not exercise usage policies. */
export const layerNoop: Layer.Layer<UsagePolicyService> = Layer.succeed(
  UsagePolicyService,
  UsagePolicyService.of({
    evaluate: () => Effect.succeed({ decision: "allow", groups: [] }),
    record: () => Effect.succeed({ decision: "allow", groups: [] }),
    status: Effect.succeed({
      day: "1970-01-01",
      resetsAt: "1970-01-02T00:00:00.000Z",
      policies: [],
    }),
    subscribe: Effect.succeed({
      latest: { day: "1970-01-01", resetsAt: "1970-01-02T00:00:00.000Z", policies: [] },
      changes: Stream.empty,
    }),
  }),
);
