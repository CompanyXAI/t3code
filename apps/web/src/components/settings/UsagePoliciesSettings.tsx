import {
  OPENAI_FREE_DAILY_PRESET,
  OPENAI_FREE_DAILY_POLICY_ID,
  type UsagePolicy,
} from "@t3tools/contracts";
import { formatTokens } from "@t3tools/shared/usageFormat";

import { usePrimarySettings, useUpdatePrimarySettings } from "~/hooks/useSettings";
import { Button } from "../ui/button";
import { searchableSetting } from "./settingsSearch";
import { SettingsSection } from "./settingsLayout";

export function UsagePoliciesSettings({ readOnly = false }: { readonly readOnly?: boolean }) {
  const usagePolicies = usePrimarySettings((settings) => settings.usagePolicies);
  const updateSettings = useUpdatePrimarySettings();
  const policies = Object.values(usagePolicies);
  const hasOpenAiPreset = OPENAI_FREE_DAILY_POLICY_ID in usagePolicies;

  const search = searchableSetting("usage-policies");
  return (
    <SettingsSection id={search.id} title={search.title}>
      <div className="flex flex-col gap-3 px-1 pb-2">
        <p className="text-xs text-muted-foreground">
          T3-enforced daily token caps and model allowlists. Independent of provider rate-limit
          banners. Caps reset at UTC midnight. Today's used totals come from Codex/Claude usage
          events; Cursor/Antigravity use estimateHandoffContextTokens for pre-turn projection only.
        </p>

        {policies.length === 0 ? (
          <p className="text-xs text-muted-foreground">No usage policies configured.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {policies.map((policy) => (
              <PolicyCard
                key={policy.id}
                policy={policy}
                readOnly={readOnly}
                onRemove={() =>
                  void updateSettings({
                    usagePolicies: { [policy.id]: null },
                  })
                }
              />
            ))}
          </ul>
        )}

        {!readOnly ? (
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={hasOpenAiPreset}
              onClick={() =>
                void updateSettings({
                  usagePolicies: { [OPENAI_FREE_DAILY_PRESET.id]: OPENAI_FREE_DAILY_PRESET },
                })
              }
            >
              {hasOpenAiPreset ? "OpenAI Free Daily added" : "Add OpenAI Free Daily preset"}
            </Button>
          </div>
        ) : null}
      </div>
    </SettingsSection>
  );
}

function PolicyCard(props: {
  readonly policy: UsagePolicy;
  readonly readOnly: boolean;
  readonly onRemove: () => void;
}) {
  const { policy, readOnly, onRemove } = props;
  return (
    <li className="rounded-md border border-border/60 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-medium">{policy.id}</div>
          <div className="mt-1 text-xs text-muted-foreground">
            {policy.onExceeded === "block" ? "Hard block" : "Warn only"} Â· UTC day
            {policy.authModes?.length ? ` Â· auth: ${policy.authModes.join(", ")}` : null}
            {policy.scope?.driverKind ? ` Â· driver: ${policy.scope.driverKind}` : null}
          </div>
        </div>
        {!readOnly ? (
          <Button type="button" size="sm" variant="ghost" onClick={onRemove}>
            Remove
          </Button>
        ) : null}
      </div>
      <ul className="mt-2 flex flex-col gap-1">
        {policy.groups.map((group) => (
          <li key={group.id} className="text-xs text-muted-foreground">
            <span className="font-medium text-foreground">{group.id}</span>:{" "}
            {formatTokens(group.maxTokens)} tokens (stop at {Math.round(group.stopAtRatio * 100)}
            %) Â· {group.models.length} models
          </li>
        ))}
      </ul>
    </li>
  );
}
