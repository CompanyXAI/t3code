import type { EnvironmentId } from "@t3tools/contracts";
import { CopyPlusIcon } from "lucide-react";
import { useMemo } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useEnvironments } from "../../state/environments";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { Button } from "../ui/button";
import { providerClients } from "./providerDriverMeta";
import { deriveProviderSettingsFields } from "./ProviderSettingsForm";
import {
  pairedProviderInstanceSuggestions,
  type PairedProviderInstanceSuggestion,
} from "./pairedProviderInstances.logic";
import { MACHINE_NAME_REDACT_PROPS, RedactedSensitiveText } from "./RedactedSensitiveText";

interface PairedProviderInstanceSuggestionsProps {
  readonly environmentId: EnvironmentId;
  readonly reservedIds: ReadonlySet<string>;
  readonly onPick: (suggestion: PairedProviderInstanceSuggestion) => void;
}

/** "Also on <machine>" prefills: T3 metadata only, logins stay per machine. */
export function PairedProviderInstanceSuggestions(props: PairedProviderInstanceSuggestionsProps) {
  const { environments } = useEnvironments();
  const others = environments.filter(
    (environment) => environment.environmentId !== props.environmentId,
  );
  if (others.length === 0) return null;
  return (
    <>
      {others.map((environment) => (
        <PairedEnvironmentSuggestions
          key={environment.environmentId}
          sourceEnvironmentId={environment.environmentId}
          sourceLabel={environment.label}
          {...props}
        />
      ))}
    </>
  );
}

function PairedEnvironmentSuggestions(
  props: PairedProviderInstanceSuggestionsProps & {
    readonly sourceEnvironmentId: EnvironmentId;
    readonly sourceLabel: string;
  },
) {
  const sourceInstances = useEnvironmentSettings(
    props.sourceEnvironmentId,
    (s) => s.providerInstances,
  );
  const targetInstances = useEnvironmentSettings(props.environmentId, (s) => s.providerInstances);
  const suggestions = useMemo(
    () =>
      pairedProviderInstanceSuggestions({
        sourceInstances,
        targetInstances,
        reservedIds: props.reservedIds,
        isKnownDriver: (driver) => providerClients.definitions.some((d) => d.driverKind === driver),
        fieldsFor: (driver) => {
          const definition = providerClients.definitions.find((d) => d.driverKind === driver);
          return definition ? deriveProviderSettingsFields(definition) : [];
        },
      }),
    [props.reservedIds, sourceInstances, targetInstances],
  );
  if (suggestions.length === 0) return null;
  return (
    <div className="grid gap-1.5 pt-3">
      <div className="text-xs text-muted-foreground">
        Already set up on{" "}
        <RedactedSensitiveText
          value={props.sourceLabel}
          {...MACHINE_NAME_REDACT_PROPS}
          className="text-xs"
        />{" "}
        ? add the same one here? Sign-in stays per machine.
      </div>
      {suggestions.map((suggestion) => (
        <Button
          key={suggestion.sourceInstanceId}
          variant="outline"
          size="sm"
          className="justify-start"
          onClick={() => props.onPick(suggestion)}
        >
          <span className="flex min-w-0 flex-1 items-center gap-2">
            <ProviderInstanceIcon
              driverKind={suggestion.driver}
              displayName={suggestion.label}
              iconClassName="size-4"
            />
            <span className="min-w-0 flex-1 truncate text-left">{suggestion.label}</span>
            <span className="truncate font-mono text-xs text-muted-foreground">
              {suggestion.instanceIdClash ? "new id" : suggestion.sourceInstanceId}
            </span>
            <CopyPlusIcon className="size-3.5 shrink-0" aria-hidden />
          </span>
        </Button>
      ))}
    </div>
  );
}
