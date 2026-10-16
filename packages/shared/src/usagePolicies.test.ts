import { describe, expect, it } from "vite-plus/test";
import {
  OPENAI_FREE_DAILY_PRESET,
  ProviderDriverKind,
  UsagePolicyId,
  type UsagePolicy,
} from "@t3tools/contracts";

import {
  evaluateUsagePolicies,
  evaluateUsagePolicy,
  findGroupForModel,
  isModelAllowedByPolicy,
  normalizeUsageModelId,
  estimateHandoffContextTokens,
  utcDayResetsAtIso,
  openaiFreeDailyPreset,
  totalTokensFromCounts,
  utcDayKey,
} from "./usagePolicies.ts";

describe("normalizeUsageModelId", () => {
  it("strips provider prefixes and dated suffixes", () => {
    expect(normalizeUsageModelId("openai/gpt-5.4")).toBe("gpt-5.4");
    expect(normalizeUsageModelId("gpt-5.4-2025-04-14")).toBe("gpt-5.4");
    expect(normalizeUsageModelId("gpt-5.4-20250414")).toBe("gpt-5.4");
    expect(normalizeUsageModelId("GPT-5.4-mini")).toBe("gpt-5.4-mini");
    expect(normalizeUsageModelId("claude-fable-5-1[1m]")).toBe("claude-fable-5-1");
  });

  it("keeps Codex catalog ids used by fixtures", () => {
    expect(normalizeUsageModelId("gpt-5.4")).toBe("gpt-5.4");
    expect(normalizeUsageModelId("gpt-5.4-mini")).toBe("gpt-5.4-mini");
    expect(normalizeUsageModelId("o4-mini")).toBe("o4-mini");
  });
});

describe("openai free daily preset", () => {
  it("matches OpenAI Free Daily model groups", () => {
    const preset = openaiFreeDailyPreset();
    expect(preset).toEqual(OPENAI_FREE_DAILY_PRESET);
    expect(findGroupForModel(preset, "gpt-5.4")?.id).toBe("standard");
    expect(findGroupForModel(preset, "gpt-5.4-2025-04-14")?.id).toBe("standard");
    expect(findGroupForModel(preset, "openai/gpt-5.4-mini")?.id).toBe("mini");
    expect(isModelAllowedByPolicy(preset, "gpt-5.4")).toBe(true);
    expect(isModelAllowedByPolicy(preset, "gpt-image-1")).toBe(false);
  });
});

describe("evaluateUsagePolicy", () => {
  const policy: UsagePolicy = {
    id: UsagePolicyId.make("test"),
    groups: [
      { id: "standard", models: ["gpt-5.4"], maxTokens: 1000, stopAtRatio: 0.9 },
      { id: "mini", models: ["gpt-5.4-mini"], maxTokens: 10_000, stopAtRatio: 0.9 },
    ],
    allowlist: "groups",
    onExceeded: "block",
    resetTimezone: "UTC",
    period: "day",
  };

  it("blocks models outside the allowlist", () => {
    const result = evaluateUsagePolicy({
      policy,
      model: "gpt-image-1",
      usedTokensInGroup: 0,
    });
    expect(result.decision).toBe("block_model");
  });

  it("blocks when the hard cap is exhausted", () => {
    const result = evaluateUsagePolicy({
      policy,
      model: "gpt-5.4",
      usedTokensInGroup: 1000,
    });
    expect(result.decision).toBe("block_cap");
    expect(result.groupId).toBe("standard");
  });

  it("warns instead of blocking when onExceeded is warn", () => {
    const result = evaluateUsagePolicy({
      policy: { ...policy, onExceeded: "warn" },
      model: "gpt-5.4",
      usedTokensInGroup: 1000,
    });
    expect(result.decision).toBe("warn_cap");
  });

  it("interrupts at stopAtRatio mid-turn before the hard cap", () => {
    const result = evaluateUsagePolicy({
      policy,
      model: "gpt-5.4",
      usedTokensInGroup: 900,
      midTurn: true,
    });
    expect(result.decision).toBe("interrupt_cap");
  });

  it("allows under the soft stop", () => {
    const result = evaluateUsagePolicy({
      policy,
      model: "gpt-5.4",
      usedTokensInGroup: 899,
      midTurn: true,
    });
    expect(result.decision).toBe("allow");
  });
});

describe("evaluateUsagePolicies", () => {
  it("skips policies that do not match auth mode or instance", () => {
    const result = evaluateUsagePolicies({
      policies: [OPENAI_FREE_DAILY_PRESET],
      instanceId: "codex",
      driverKind: ProviderDriverKind.make("codex"),
      authMode: "chatgpt",
      model: "gpt-5.4",
      usedTokensByGroup: new Map([["openai-free-daily:standard", 250_000]]),
    });
    expect(result.decision).toBe("allow");
  });

  it("blocks apiKey traffic at the Free Daily hard cap", () => {
    const result = evaluateUsagePolicies({
      policies: [OPENAI_FREE_DAILY_PRESET],
      instanceId: "codex",
      driverKind: ProviderDriverKind.make("codex"),
      authMode: "apiKey",
      model: "gpt-5.4",
      usedTokensByGroup: new Map([["openai-free-daily:standard", 250_000]]),
    });
    expect(result.decision).toBe("block_cap");
  });

  it("keeps separate counters per group", () => {
    const result = evaluateUsagePolicies({
      policies: [OPENAI_FREE_DAILY_PRESET],
      instanceId: "codex",
      driverKind: ProviderDriverKind.make("codex"),
      authMode: "apiKey",
      model: "gpt-5.4-mini",
      usedTokensByGroup: new Map([["openai-free-daily:standard", 250_000]]),
    });
    expect(result.decision).toBe("allow");
  });
});

describe("estimateHandoffContextTokens", () => {
  it("prefers provider-reported tokens over transcript estimate", () => {
    expect(estimateHandoffContextTokens(5_000, [{ text: "abcd" }])).toBe(5_000);
    expect(estimateHandoffContextTokens(null, [{ text: "abcd" }, { text: "abcde" }])).toBe(3);
    expect(estimateHandoffContextTokens(0, [])).toBe(0);
  });
});

describe("utcDayResetsAtIso", () => {
  it("returns the next UTC midnight after the day", () => {
    expect(utcDayResetsAtIso("2026-10-15")).toBe("2026-10-16T00:00:00.000Z");
    expect(utcDayResetsAtIso("2026-12-31")).toBe("2027-01-01T00:00:00.000Z");
  });
});

describe("projectedAdditionalTokens", () => {
  it("adds the pre-turn projection onto the recorded group total", () => {
    const result = evaluateUsagePolicies({
      policies: [OPENAI_FREE_DAILY_PRESET],
      instanceId: "codex",
      driverKind: ProviderDriverKind.make("codex"),
      authMode: "apiKey",
      model: "gpt-5.4",
      usedTokensByGroup: new Map([["openai-free-daily:standard", 200_000]]),
      projectedAdditionalTokens: 60_000,
    });
    expect(result.decision).toBe("block_cap");
  });

  it("still prefers reported tokens via estimateHandoffContextTokens", () => {
    expect(estimateHandoffContextTokens(250_001, [{ text: "x".repeat(40) }])).toBe(250_001);
  });
});

describe("token helpers", () => {
  it("sums input and output without double-counting cache fields", () => {
    expect(
      totalTokensFromCounts({
        inputTokens: 100,
        cachedInputTokens: 40,
        cacheCreationTokens: 10,
        outputTokens: 20,
        reasoningTokens: 5,
      }),
    ).toBe(120);
  });

  it("formats a UTC day key", () => {
    expect(utcDayKey("2026-10-15T23:59:59.000Z")).toBe("2026-10-15");
    expect(utcDayKey("2026-10-16T00:00:00.000Z")).toBe("2026-10-16");
  });
});
