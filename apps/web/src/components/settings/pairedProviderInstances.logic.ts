import type { ProviderDriverKind, ProviderInstanceConfig } from "@t3tools/contracts";

import type { ProviderSettingsFieldModel } from "./ProviderSettingsForm";

/** A provider instance configured on another paired machine, offered as a prefill. */
export interface PairedProviderInstanceSuggestion {
  readonly sourceInstanceId: string;
  readonly driver: ProviderDriverKind;
  readonly label: string;
  readonly accentColor: string;
  readonly config: Record<string, unknown>;
  /** The id is taken on this machine by a different provider; a new id is derived. */
  readonly instanceIdClash: boolean;
}

// Config keys that name a location on the source machine (homePath, binaryPath,
// commandPath, ...). They are machine-specific and never copied.
const MACHINE_PATH_KEY = /(path|home|dir|directory)$/i;
const ABSOLUTE_PATH_VALUE = /^(~[\\/]|\/|[a-zA-Z]:[\\/]|\\\\)/;

/**
 * Non-secret, non-path config values for the target driver's declared fields.
 * Secrets (server-redacted anyway), unknown keys and machine paths are dropped.
 */
export function copyableProviderConfig(
  fields: ReadonlyArray<ProviderSettingsFieldModel>,
  config: unknown,
): Record<string, unknown> {
  if (config === null || typeof config !== "object" || Array.isArray(config)) return {};
  const source = config as Record<string, unknown>;
  const copied: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.secret || MACHINE_PATH_KEY.test(field.key)) continue;
    const value = source[field.key];
    if (value === undefined || value === null) continue;
    if (typeof value === "string" && ABSOLUTE_PATH_VALUE.test(value.trim())) continue;
    copied[field.key] = value;
  }
  return copied;
}

/**
 * Instances on another machine that this machine does not have yet. An id
 * already used here by the same driver counts as present; by another driver it
 * is a clash and the suggestion asks for a fresh id.
 */
export function pairedProviderInstanceSuggestions(input: {
  readonly sourceInstances: Readonly<Record<string, ProviderInstanceConfig>> | undefined;
  readonly targetInstances: Readonly<Record<string, ProviderInstanceConfig>> | undefined;
  readonly reservedIds: ReadonlySet<string>;
  readonly isKnownDriver: (driver: ProviderDriverKind) => boolean;
  readonly fieldsFor: (driver: ProviderDriverKind) => ReadonlyArray<ProviderSettingsFieldModel>;
}): ReadonlyArray<PairedProviderInstanceSuggestion> {
  const suggestions: Array<PairedProviderInstanceSuggestion> = [];
  for (const [instanceId, instance] of Object.entries(input.sourceInstances ?? {})) {
    if (!input.isKnownDriver(instance.driver)) continue;
    const target = input.targetInstances?.[instanceId];
    if (target !== undefined && target.driver === instance.driver) continue;
    const instanceIdClash = target !== undefined || input.reservedIds.has(instanceId);
    // A reserved default slot (codex / claudeAgent) of the same driver is the same instance.
    if (instanceIdClash && target === undefined && instanceId === instance.driver) continue;
    suggestions.push({
      sourceInstanceId: instanceId,
      driver: instance.driver,
      label: instance.displayName?.trim() || instanceId,
      accentColor: instance.accentColor ?? "",
      config: copyableProviderConfig(input.fieldsFor(instance.driver), instance.config),
      instanceIdClash,
    });
  }
  return suggestions.toSorted((a, b) => a.label.localeCompare(b.label));
}
