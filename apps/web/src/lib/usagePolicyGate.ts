/**
 * Client-side gate for T3 usage policies: greys models the allowlist rejects.
 * Cap exhaustion still needs a server round-trip; this covers model allowlists.
 */
import {
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ServerSettings,
  type UsagePolicy,
} from "@t3tools/contracts";
import {
  isModelAllowedByPolicy,
  policyAppliesToAuthMode,
  policyAppliesToInstance,
  resolveUsageAuthMode,
} from "@t3tools/shared/usagePolicies";

export function usagePoliciesFromSettings(
  settings: Pick<ServerSettings, "usagePolicies">,
): ReadonlyArray<UsagePolicy> {
  return Object.values(settings.usagePolicies);
}

export function modelBlockedByUsagePolicy(input: {
  readonly settings: Pick<ServerSettings, "usagePolicies">;
  readonly instanceId: ProviderInstanceId;
  readonly driverKind: ProviderDriverKind | string;
  readonly model: string;
  readonly authType?: string | null | undefined;
}): string | null {
  const authMode = resolveUsageAuthMode(input.authType);
  for (const policy of usagePoliciesFromSettings(input.settings)) {
    if (
      !policyAppliesToInstance(policy, {
        instanceId: input.instanceId,
        driverKind: input.driverKind,
      })
    ) {
      continue;
    }
    if (!policyAppliesToAuthMode(policy, authMode)) continue;
    if (!isModelAllowedByPolicy(policy, input.model)) {
      return `Blocked by usage policy "${policy.id}".`;
    }
  }
  return null;
}
