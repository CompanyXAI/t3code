import { AuthOrchestrationReadScope } from "@t3tools/contracts";
import type { EnvironmentId, UsagePolicyStatus } from "@t3tools/contracts";

import { usePrimaryEnvironment } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { serverEnvironment } from "../state/server";
import { useEnvironmentScope } from "../state/session";

export interface UsagePolicyStatusState {
  readonly data: UsagePolicyStatus | null;
  readonly error: string | null;
  readonly isPending: boolean;
  readonly refresh: () => void;
}

export function useUsagePolicyStatus(
  targetEnvironmentId?: EnvironmentId | null,
): UsagePolicyStatusState {
  const primaryEnvironment = usePrimaryEnvironment();
  const environmentId =
    targetEnvironmentId === undefined
      ? (primaryEnvironment?.environmentId ?? null)
      : targetEnvironmentId;
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  return useEnvironmentQuery(
    environmentId === null || !canRead
      ? null
      : serverEnvironment.usagePolicyStatus({ environmentId, input: {} }),
  );
}
