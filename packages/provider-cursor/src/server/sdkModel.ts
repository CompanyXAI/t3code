import type { ModelSelection as CursorSdkModelSelection, ModelParameterValue } from "@cursor/sdk";
import type { ModelSelection } from "@t3tools/contracts";

import { cursorModelOptions } from "./runsOn.ts";

const CURSOR_SDK_PARAMETER_TO_PROVIDER_OPTION: Readonly<Record<string, string>> = {
  context: "contextWindow",
  fast: "fastMode",
};

const PROVIDER_OPTION_TO_CURSOR_SDK_PARAMETER: Readonly<Record<string, string>> = {
  contextWindow: "context",
  fastMode: "fast",
};

export function cursorSdkProviderOptionId(parameterId: string): string {
  return CURSOR_SDK_PARAMETER_TO_PROVIDER_OPTION[parameterId] ?? parameterId;
}

function cursorSdkParameterId(providerOptionId: string): string {
  return PROVIDER_OPTION_TO_CURSOR_SDK_PARAMETER[providerOptionId] ?? providerOptionId;
}

export function cursorSdkParameterPriority(parameterId: string): number {
  switch (parameterId) {
    case "effort":
    case "reasoning":
      return 0;
    case "context":
      return 1;
    case "fast":
      return 2;
    case "thinking":
      return 3;
    default:
      return 4;
  }
}

export function cursorSdkModelSelection(modelSelection: ModelSelection): CursorSdkModelSelection {
  // "Runs on" is T3's choice of where the agent runs, not a Cursor model parameter.
  const options = cursorModelOptions(modelSelection.options);
  return {
    id: modelSelection.model === "auto" ? "default" : modelSelection.model,
    ...(options.length === 0
      ? {}
      : {
          params: options.map((option): ModelParameterValue => ({
            id: cursorSdkParameterId(option.id),
            value: String(option.value),
          })),
        }),
  };
}
