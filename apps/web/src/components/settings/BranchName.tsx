import type { ComponentProps } from "react";

import { cn } from "../../lib/utils";
import { useEnvironments } from "../../state/environments";
import { MiddleTruncate } from "../ui/middle-truncate";
import { redactedPlaceholder } from "./RedactedSensitiveText";
import { isRedactionRevealed, redactionItemKey, useRedactionState } from "./redactionReveal";

/** True when a branch name contains a known machine name (e.g. `machine-alpha/fix`), case-insensitive. */
export function branchContainsMachineName(
  branch: string,
  machineLabels: ReadonlyArray<string>,
): boolean {
  const lower = branch.toLowerCase();
  return machineLabels.some((label) => {
    const trimmed = label.trim().toLowerCase();
    return trimmed.length >= 3 && lower.includes(trimmed);
  });
}

/**
 * Branch name display. Branches that embed a paired machine's name are blurred
 * under the machine category (revealed per item or via the header toggles);
 * other branches render unchanged. Non-interactive, so it is safe inside rows,
 * links and buttons.
 */
export function BranchName({
  value,
  className,
  ...props
}: Omit<ComponentProps<typeof MiddleTruncate>, "value"> & { value: string }) {
  const { environments } = useEnvironments();
  const redactionState = useRedactionState();
  const sensitive = branchContainsMachineName(
    value,
    environments.map((environment) => environment.label),
  );
  const revealed =
    !sensitive ||
    isRedactionRevealed(redactionState, "machine", redactionItemKey("machine", value));
  if (revealed) return <MiddleTruncate value={value} className={className} {...props} />;
  return (
    <MiddleTruncate
      {...props}
      value={redactedPlaceholder(value)}
      showTitle={false}
      aria-label="Branch name hidden (contains a machine name)"
      className={cn("select-none blur-xs", className)}
    />
  );
}
