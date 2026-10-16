import { ProviderDriverKind, type ProviderInstanceConfig } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ProviderSettingsFieldModel } from "./ProviderSettingsForm";
import {
  copyableProviderConfig,
  pairedProviderInstanceSuggestions,
} from "./pairedProviderInstances.logic";

const field = (key: string, extra: Partial<ProviderSettingsFieldModel> = {}) =>
  ({
    key,
    control: "text",
    label: key,
    clearWhenEmpty: "omit",
    ...extra,
  }) as ProviderSettingsFieldModel;
const cursorFields = [
  field("approvalHooks", { control: "switch" } as never),
  field("homePath"),
  field("apiKey", { secret: true }),
  field("model"),
];
const cursor = ProviderDriverKind.make("cursor");
const codex = ProviderDriverKind.make("codex");
const instance = (driver: ProviderDriverKind, extra: Partial<ProviderInstanceConfig> = {}) =>
  ({ driver, enabled: true, ...extra }) as ProviderInstanceConfig;

describe("copyableProviderConfig", () => {
  it("drops secrets, machine paths and unknown keys", () => {
    expect(
      copyableProviderConfig(cursorFields, {
        approvalHooks: true,
        homePath: "C:\\Users\\me\\.cursor-2",
        apiKey: "",
        model: "/opt/models/x",
        unknown: 1,
      }),
    ).toEqual({ approvalHooks: true });
    expect(copyableProviderConfig(cursorFields, { model: "gpt-5" })).toEqual({ model: "gpt-5" });
    expect(copyableProviderConfig(cursorFields, undefined)).toEqual({});
  });
});

describe("pairedProviderInstanceSuggestions", () => {
  const base = {
    reservedIds: new Set(["codex", "claudeAgent", "cursor_2"]),
    isKnownDriver: (driver: ProviderDriverKind) => driver === cursor || driver === codex,
    fieldsFor: () => cursorFields,
  };
  it("offers instances missing here with label, accent and copyable config", () => {
    expect(
      pairedProviderInstanceSuggestions({
        ...base,
        reservedIds: new Set(["codex", "claudeAgent"]),
        sourceInstances: {
          cursor_3: instance(cursor, {
            displayName: "Work",
            accentColor: "#ff0000",
            config: { approvalHooks: true, homePath: "C:\\x" },
          }),
        },
        targetInstances: {},
      }),
    ).toEqual([
      {
        sourceInstanceId: "cursor_3",
        driver: cursor,
        label: "Work",
        accentColor: "#ff0000",
        config: { approvalHooks: true },
        instanceIdClash: false,
      },
    ]);
  });
  it("skips instances already here and flags ids taken by another driver", () => {
    const suggestions = pairedProviderInstanceSuggestions({
      ...base,
      sourceInstances: {
        cursor_1: instance(cursor),
        cursor_2: instance(cursor),
        codex: instance(codex),
        other: instance(ProviderDriverKind.make("unknownDriver")),
      },
      targetInstances: { cursor_1: instance(cursor), cursor_2: instance(codex) },
    });
    expect(suggestions.map((s) => [s.sourceInstanceId, s.instanceIdClash])).toEqual([
      ["cursor_2", true],
    ]);
  });
});
