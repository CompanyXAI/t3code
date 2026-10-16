import { describe, expect, it } from "vite-plus/test";
import {
  OPENAI_FREE_DAILY_PRESET,
  ProviderDriverKind,
  ProviderInstanceId,
  DEFAULT_SERVER_SETTINGS,
} from "@t3tools/contracts";

import { modelBlockedByUsagePolicy } from "./usagePolicyGate.ts";

describe("modelBlockedByUsagePolicy", () => {
  it("greys models outside the OpenAI Free Daily allowlist for apiKey", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      usagePolicies: { [OPENAI_FREE_DAILY_PRESET.id]: OPENAI_FREE_DAILY_PRESET },
    };
    expect(
      modelBlockedByUsagePolicy({
        settings,
        instanceId: ProviderInstanceId.make("codex"),
        driverKind: ProviderDriverKind.make("codex"),
        model: "gpt-image-1",
        authType: "apiKey",
      }),
    ).toContain("openai-free-daily");
    expect(
      modelBlockedByUsagePolicy({
        settings,
        instanceId: ProviderInstanceId.make("codex"),
        driverKind: ProviderDriverKind.make("codex"),
        model: "gpt-5.4",
        authType: "apiKey",
      }),
    ).toBeNull();
  });

  it("does not apply the Free Daily allowlist to ChatGPT login", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      usagePolicies: { [OPENAI_FREE_DAILY_PRESET.id]: OPENAI_FREE_DAILY_PRESET },
    };
    expect(
      modelBlockedByUsagePolicy({
        settings,
        instanceId: ProviderInstanceId.make("codex"),
        driverKind: ProviderDriverKind.make("codex"),
        model: "gpt-image-1",
        authType: "chatgpt",
      }),
    ).toBeNull();
  });
});
