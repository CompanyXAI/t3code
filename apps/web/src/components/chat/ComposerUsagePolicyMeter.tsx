import type { UsagePolicyStatus } from "@t3tools/contracts";
import { formatTokens } from "@t3tools/shared/usageFormat";

import { useUsagePolicyStatus } from "../../lib/usagePolicyStatusState";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * Live T3 usage-policy meter: "today X / cap" per group, fed by
 * `subscribeUsagePolicyStatus` (updates when usage is recorded).
 */
export function ComposerUsagePolicyMeter(props: {
  readonly status: UsagePolicyStatus;
  /** When the pre-turn projection used chars/4 rather than reported tokens. */
  readonly estimated?: boolean;
}) {
  const groups = props.status.policies.flatMap((entry) =>
    entry.groups.map((group) => ({
      key: `${entry.policy.id}:${group.groupId}`,
      groupId: group.groupId,
      usedTokens: group.usedTokens,
      maxTokens: group.maxTokens,
    })),
  );
  if (groups.length === 0) return null;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground" />
        }
      >
        {groups.map((group) => (
          <span key={group.key} className="whitespace-nowrap">
            <span className="text-foreground/80">{group.groupId}</span>
            {": today "}
            <span className="tabular-nums text-foreground">{formatTokens(group.usedTokens)}</span>
            {" / "}
            <span className="tabular-nums">{formatTokens(group.maxTokens)}</span>
          </span>
        ))}
        {props.estimated ? (
          <span className="rounded bg-muted px-1 py-0.5 text-3xs uppercase tracking-wide text-muted-foreground">
            estimated
          </span>
        ) : null}
      </TooltipTrigger>
      <TooltipPopup>{`Resets ${props.status.resetsAt} (UTC day ${props.status.day})`}</TooltipPopup>
    </Tooltip>
  );
}

/** Subscribes to usage-policy status and renders the live meter when policies exist. */
export function ComposerUsagePolicyMeterLive(props: { readonly estimated?: boolean }) {
  const { data } = useUsagePolicyStatus();
  if (data === null || data.policies.length === 0) return null;
  return (
    <ComposerUsagePolicyMeter
      status={data}
      {...(props.estimated === true || data.estimated === true ? { estimated: true as const } : {})}
    />
  );
}
