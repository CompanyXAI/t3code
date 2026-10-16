/**
 * Config-driven T3 usage policies: model group caps and allowlists enforced by
 * the server before and during turns, independent of provider-reported limits.
 *
 * @module usagePolicies
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

export const UsagePolicyId = TrimmedNonEmptyString.pipe(Schema.brand("UsagePolicyId"));
export type UsagePolicyId = typeof UsagePolicyId.Type;

export const UsagePolicyPeriod = Schema.Literal("day");
export type UsagePolicyPeriod = typeof UsagePolicyPeriod.Type;

export const UsagePolicyOnExceeded = Schema.Literals(["block", "warn"]);
export type UsagePolicyOnExceeded = typeof UsagePolicyOnExceeded.Type;

export const UsagePolicyAllowlistMode = Schema.Literal("groups");
export type UsagePolicyAllowlistMode = typeof UsagePolicyAllowlistMode.Type;

export const UsagePolicyAuthMode = Schema.Literals([
  "apiKey",
  "chatgpt",
  "subscription",
  "unknown",
]);
export type UsagePolicyAuthMode = typeof UsagePolicyAuthMode.Type;

export const UsagePolicyGroup = Schema.Struct({
  id: TrimmedNonEmptyString,
  models: Schema.Array(TrimmedNonEmptyString),
  maxTokens: Schema.Int.check(Schema.isGreaterThan(0)),
  stopAtRatio: Schema.Number.check(Schema.isBetween({ minimum: 0.01, maximum: 1 })).pipe(
    Schema.withDecodingDefault(Effect.succeed(0.9)),
  ),
});
export type UsagePolicyGroup = typeof UsagePolicyGroup.Type;

/**
 * Optional narrow. Empty scope means every instance. `driverKind` and
 * `instanceId` both set must agree with the instance being evaluated.
 */
export const UsagePolicyScope = Schema.Struct({
  driverKind: Schema.optionalKey(ProviderDriverKind),
  instanceId: Schema.optionalKey(ProviderInstanceId),
});
export type UsagePolicyScope = typeof UsagePolicyScope.Type;

export const UsagePolicy = Schema.Struct({
  id: UsagePolicyId,
  scope: Schema.optionalKey(UsagePolicyScope),
  resetTimezone: Schema.Literal("UTC").pipe(
    Schema.withDecodingDefault(Effect.succeed("UTC" as const)),
  ),
  period: UsagePolicyPeriod.pipe(Schema.withDecodingDefault(Effect.succeed("day" as const))),
  groups: Schema.Array(UsagePolicyGroup),
  /**
   * `"groups"`: only models listed in any group are allowed.
   * A string array: exactly those model ids (after normalization) are allowed.
   */
  allowlist: Schema.Union([UsagePolicyAllowlistMode, Schema.Array(TrimmedNonEmptyString)]).pipe(
    Schema.withDecodingDefault(Effect.succeed("groups" as const)),
  ),
  onExceeded: UsagePolicyOnExceeded.pipe(
    Schema.withDecodingDefault(Effect.succeed("block" as const)),
  ),
  /**
   * When set, the policy applies only while the instance auth type is one of
   * these (Codex reports `apiKey` / `chatgpt`). Omitted = every auth mode.
   */
  authModes: Schema.optionalKey(Schema.Array(UsagePolicyAuthMode)),
});
export type UsagePolicy = typeof UsagePolicy.Type;

export const UsageTokenCounts = Schema.Struct({
  inputTokens: NonNegativeInt,
  cachedInputTokens: NonNegativeInt,
  cacheCreationTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  reasoningTokens: NonNegativeInt,
});
export type UsageTokenCounts = typeof UsageTokenCounts.Type;

export const UsagePolicyGroupUsage = Schema.Struct({
  groupId: TrimmedNonEmptyString,
  usedTokens: NonNegativeInt,
  maxTokens: Schema.Int.check(Schema.isGreaterThan(0)),
  stopAtRatio: Schema.Number,
  stopAtTokens: NonNegativeInt,
});
export type UsagePolicyGroupUsage = typeof UsagePolicyGroupUsage.Type;

export const UsagePolicyDecision = Schema.Literals([
  "allow",
  "block_model",
  "block_cap",
  "warn_cap",
  "interrupt_cap",
]);
export type UsagePolicyDecision = typeof UsagePolicyDecision.Type;

export const UsagePolicyEvaluation = Schema.Struct({
  decision: UsagePolicyDecision,
  policyId: Schema.optionalKey(UsagePolicyId),
  groupId: Schema.optionalKey(TrimmedNonEmptyString),
  message: Schema.optionalKey(TrimmedNonEmptyString),
  groups: Schema.Array(UsagePolicyGroupUsage),
});
export type UsagePolicyEvaluation = typeof UsagePolicyEvaluation.Type;

export const UsagePolicyStatus = Schema.Struct({
  /** UTC calendar day YYYY-MM-DD the counters apply to. */
  day: TrimmedNonEmptyString,
  /** ISO timestamp when the UTC day rolls (next midnight). */
  resetsAt: TrimmedNonEmptyString,
  /** The latest pre-turn projection used chars/4 instead of reported tokens. */
  estimated: Schema.optionalKey(Schema.Boolean),
  policies: Schema.Array(
    Schema.Struct({
      policy: UsagePolicy,
      groups: Schema.Array(UsagePolicyGroupUsage),
    }),
  ),
});
export type UsagePolicyStatus = typeof UsagePolicyStatus.Type;

/** OpenAI Free Daily shared-traffic caps (UTC day). */
export const OPENAI_FREE_DAILY_POLICY_ID = UsagePolicyId.make("openai-free-daily");

export const OPENAI_FREE_DAILY_STANDARD_MODELS = [
  "gpt-5.4",
  "gpt-5.2",
  "gpt-5.1",
  "gpt-5",
  "gpt-4.1",
  "gpt-4o",
  "o1",
  "o3",
] as const;

export const OPENAI_FREE_DAILY_MINI_MODELS = [
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "gpt-5-mini",
  "gpt-5-nano",
  "gpt-4.1-mini",
  "gpt-4.1-nano",
  "gpt-4o-mini",
  "o3-mini",
  "o4-mini",
] as const;

export const OPENAI_FREE_DAILY_PRESET: UsagePolicy = {
  id: OPENAI_FREE_DAILY_POLICY_ID,
  scope: { driverKind: ProviderDriverKind.make("codex") },
  resetTimezone: "UTC",
  period: "day",
  groups: [
    {
      id: "standard",
      models: [...OPENAI_FREE_DAILY_STANDARD_MODELS],
      maxTokens: 250_000,
      stopAtRatio: 0.9,
    },
    {
      id: "mini",
      models: [...OPENAI_FREE_DAILY_MINI_MODELS],
      maxTokens: 2_500_000,
      stopAtRatio: 0.9,
    },
  ],
  allowlist: "groups",
  onExceeded: "block",
  authModes: ["apiKey"],
};
