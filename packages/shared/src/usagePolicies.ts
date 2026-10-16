/**
 * Pure helpers for T3 usage policies: model id normalization, group matching,
 * and cap evaluation. Shared by the server enforcer and the web UI.
 *
 * @module usagePolicies
 */
import {
  OPENAI_FREE_DAILY_PRESET,
  type UsagePolicy,
  type UsagePolicyAuthMode,
  type UsagePolicyEvaluation,
  type UsagePolicyGroup,
  type UsagePolicyGroupUsage,
  type UsageTokenCounts,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/** Dated OpenAI snapshot suffixes such as `-2025-04-14` or `-20240414`. */
const DATED_MODEL_SUFFIX = /-(?:20\d{2}(?:-?\d{2}){2})$/;

/**
 * Canonical model id for allowlist / group matching.
 * Strips provider prefixes (`openai/`), dated snapshot suffixes, and lowercases.
 */
export function normalizeUsageModelId(model: string): string {
  let value = model.trim().toLowerCase();
  const slash = value.lastIndexOf("/");
  if (slash !== -1) value = value.slice(slash + 1);
  const bracket = value.indexOf("[");
  if (bracket !== -1) value = value.slice(0, bracket);
  value = value.replace(DATED_MODEL_SUFFIX, "");
  return value;
}

export function totalTokensFromCounts(counts: UsageTokenCounts): number {
  // Cached and cache-creation tokens are already part of inputTokens for Codex
  // and Claude billed usage; do not double-count them.
  return counts.inputTokens + counts.outputTokens;
}

export function emptyTokenCounts(): UsageTokenCounts {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
  };
}

export function addTokenCounts(a: UsageTokenCounts, b: UsageTokenCounts): UsageTokenCounts {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
  };
}

/**
 * Context size for handoffs and for pre-turn projections when a provider has
 * no live billable usage yet: prefer the provider-reported context size, else
 * chars/4 of the transcript texts (an estimate ? label it as such in the UI).
 */
export function estimateHandoffContextTokens(
  reportedTokens: number | null | undefined,
  messages: ReadonlyArray<{ readonly text: string }>,
): number {
  if (reportedTokens != null && reportedTokens > 0) return reportedTokens;
  const chars = messages.reduce((sum, message) => sum + message.text.length, 0);
  return Math.ceil(chars / 4);
}

/** UTC calendar day `YYYY-MM-DD` for the policy period. */
export function utcDayKey(instant: string | DateTime.Utc): string {
  const iso = typeof instant === "string" ? instant : DateTime.formatIso(instant);
  return iso.slice(0, 10);
}

/** ISO timestamp of the next UTC midnight after `day` (YYYY-MM-DD). */
export function utcDayResetsAtIso(day: string): string {
  const start = DateTime.makeUnsafe(`${day}T00:00:00.000Z`);
  return DateTime.formatIso(DateTime.add(start, { days: 1 }));
}

export function resolveUsageAuthMode(authType: string | undefined | null): UsagePolicyAuthMode {
  if (authType === "apiKey" || authType === "chatgpt" || authType === "subscription") {
    return authType;
  }
  return "unknown";
}

export function policyAppliesToAuthMode(
  policy: UsagePolicy,
  authMode: UsagePolicyAuthMode,
): boolean {
  if (policy.authModes === undefined || policy.authModes.length === 0) return true;
  return policy.authModes.includes(authMode);
}

export function policyAppliesToInstance(
  policy: UsagePolicy,
  input: {
    readonly instanceId: string;
    readonly driverKind: string;
  },
): boolean {
  const scope = policy.scope;
  if (scope === undefined) return true;
  if (scope.instanceId !== undefined && scope.instanceId !== input.instanceId) return false;
  if (scope.driverKind !== undefined && scope.driverKind !== input.driverKind) return false;
  return true;
}

export function findGroupForModel(
  policy: UsagePolicy,
  model: string,
): UsagePolicyGroup | undefined {
  const normalized = normalizeUsageModelId(model);
  for (const group of policy.groups) {
    if (group.models.some((candidate) => normalizeUsageModelId(candidate) === normalized)) {
      return group;
    }
  }
  return undefined;
}

export function isModelAllowedByPolicy(policy: UsagePolicy, model: string): boolean {
  const normalized = normalizeUsageModelId(model);
  if (policy.allowlist === "groups") {
    return findGroupForModel(policy, normalized) !== undefined;
  }
  return policy.allowlist.some((candidate) => normalizeUsageModelId(candidate) === normalized);
}

export function groupUsageFromTotals(
  group: UsagePolicyGroup,
  usedTokens: number,
): UsagePolicyGroupUsage {
  const stopAtTokens = Math.floor(group.maxTokens * group.stopAtRatio);
  return {
    groupId: group.id,
    usedTokens: Math.max(0, Math.floor(usedTokens)),
    maxTokens: group.maxTokens,
    stopAtRatio: group.stopAtRatio,
    stopAtTokens,
  };
}

export function openaiFreeDailyPreset(): UsagePolicy {
  return OPENAI_FREE_DAILY_PRESET;
}

export interface EvaluateUsagePolicyInput {
  readonly policy: UsagePolicy;
  readonly model: string;
  /** Tokens already recorded for this UTC day in the model's group. */
  readonly usedTokensInGroup: number;
  /** When true, also emit interrupt once stopAtRatio is crossed. */
  readonly midTurn?: boolean;
}

/**
 * Pure evaluation for one applicable policy against one model choice.
 * Caller filters by scope and auth mode first.
 */
export function evaluateUsagePolicy(input: EvaluateUsagePolicyInput): UsagePolicyEvaluation {
  const { policy, model, usedTokensInGroup } = input;
  const midTurn = input.midTurn === true;
  const groups = policy.groups.map((group) =>
    groupUsageFromTotals(
      group,
      group.id === findGroupForModel(policy, model)?.id ? usedTokensInGroup : 0,
    ),
  );

  if (!isModelAllowedByPolicy(policy, model)) {
    return {
      decision: "block_model",
      policyId: policy.id,
      message: `Model "${model}" is not allowed by usage policy "${policy.id}".`,
      groups,
    };
  }

  const group = findGroupForModel(policy, model);
  if (group === undefined) {
    // Allowlist is an explicit list without groups: no cap to enforce.
    return { decision: "allow", policyId: policy.id, groups };
  }

  const usage = groupUsageFromTotals(group, usedTokensInGroup);
  if (usedTokensInGroup >= group.maxTokens) {
    if (policy.onExceeded === "warn") {
      return {
        decision: "warn_cap",
        policyId: policy.id,
        groupId: group.id,
        message: `Daily token cap for group "${group.id}" in policy "${policy.id}" is exhausted (${usage.usedTokens}/${usage.maxTokens}).`,
        groups: groups.map((entry) => (entry.groupId === group.id ? usage : entry)),
      };
    }
    return {
      decision: "block_cap",
      policyId: policy.id,
      groupId: group.id,
      message: `Daily token cap for group "${group.id}" in policy "${policy.id}" is exhausted (${usage.usedTokens}/${usage.maxTokens}).`,
      groups: groups.map((entry) => (entry.groupId === group.id ? usage : entry)),
    };
  }

  if (midTurn && usedTokensInGroup >= usage.stopAtTokens) {
    return {
      decision: "interrupt_cap",
      policyId: policy.id,
      groupId: group.id,
      message: `Daily token soft-stop for group "${group.id}" in policy "${policy.id}" reached (${usage.usedTokens}/${usage.maxTokens}, stop at ${usage.stopAtTokens}).`,
      groups: groups.map((entry) => (entry.groupId === group.id ? usage : entry)),
    };
  }

  return {
    decision: "allow",
    policyId: policy.id,
    groupId: group.id,
    groups: groups.map((entry) => (entry.groupId === group.id ? usage : entry)),
  };
}

/**
 * Evaluate every applicable policy; first blocking / interrupt decision wins.
 * Warn decisions are returned only when nothing blocks.
 */
export function evaluateUsagePolicies(input: {
  readonly policies: ReadonlyArray<UsagePolicy>;
  readonly instanceId: string;
  readonly driverKind: string;
  readonly authMode: UsagePolicyAuthMode;
  readonly model: string;
  readonly usedTokensByGroup: ReadonlyMap<string, number>;
  readonly midTurn?: boolean;
  /**
   * Extra tokens projected for this turn (providers without live usage events).
   * Added only to the matched group's used total for the decision; not persisted.
   */
  readonly projectedAdditionalTokens?: number;
}): UsagePolicyEvaluation {
  let warn: UsagePolicyEvaluation | undefined;
  const allGroups: UsagePolicyGroupUsage[] = [];
  const projected = Math.max(0, Math.floor(input.projectedAdditionalTokens ?? 0));
  const midTurn = input.midTurn === true;

  for (const policy of input.policies) {
    if (!policyAppliesToInstance(policy, input)) continue;
    if (!policyAppliesToAuthMode(policy, input.authMode)) continue;
    const group = findGroupForModel(policy, input.model);
    const used =
      group === undefined
        ? 0
        : (input.usedTokensByGroup.get(`${policy.id}:${group.id}`) ??
            input.usedTokensByGroup.get(group.id) ??
            0) + projected;
    const result = evaluateUsagePolicy({
      policy,
      model: input.model,
      usedTokensInGroup: used,
      midTurn,
    });
    allGroups.push(...result.groups);
    if (result.decision === "allow") continue;
    if (result.decision === "warn_cap") {
      warn ??= result;
      continue;
    }
    return result;
  }

  if (warn !== undefined) return warn;
  return { decision: "allow", groups: allGroups };
}
