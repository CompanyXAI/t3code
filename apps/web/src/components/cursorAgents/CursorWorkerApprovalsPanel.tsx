import type { CursorAgentEntry, EnvironmentId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { CheckIcon, ShieldCheckIcon, XIcon } from "lucide-react";
import { useMemo, useState } from "react";

import {
  cursorProjectHooksSet,
  cursorProjectHooksState,
  cursorWorkerApprovalRespond,
  cursorWorkerApprovals,
  cursorWorkerHookSetup,
  cursorWorkerHookStart,
} from "../../state/cursorAgents";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import {
  HOST_URL_REDACT_PROPS,
  PATH_REDACT_PROPS,
  RedactedSensitiveText,
} from "../settings/RedactedSensitiveText";
import { approvalKindLabel, workerSetupSteps } from "./cursorAgents.logic";

/**
 * Worker-run approvals: pending hook requests of worker agents, the bridge
 * setup with shell steps for `agent worker start`, and a per-repository
 * switch for T3's project hooks (workers load only project hooks).
 */
export function CursorWorkerApprovalsPanel({
  environmentId,
  entries,
  repoRoots,
  machineName,
}: {
  readonly environmentId: EnvironmentId;
  readonly entries: ReadonlyArray<CursorAgentEntry>;
  readonly repoRoots: ReadonlyArray<string>;
  readonly machineName: string;
}) {
  const approvalsAtom = useMemo(
    () => cursorWorkerApprovals({ environmentId, input: {} }),
    [environmentId],
  );
  const approvals = Option.getOrNull(AsyncResult.value(useAtomValue(approvalsAtom)));
  const setupAtom = useMemo(
    () => cursorWorkerHookSetup({ environmentId, input: {} }),
    [environmentId],
  );
  const fetchedSetup = Option.getOrNull(AsyncResult.value(useAtomValue(setupAtom)));
  const [setupOverride, setSetupOverride] = useState<typeof fetchedSetup>(null);
  const setup = setupOverride ?? fetchedSetup;
  const respond = useAtomCommand(cursorWorkerApprovalRespond);
  const start = useAtomCommand(cursorWorkerHookStart);
  const agentName = (agentId: string | null) =>
    entries.find((entry) => entry.agentId === agentId)?.name ?? agentId ?? "Unknown agent";

  return (
    <section aria-label="Worker approvals" className="flex flex-col gap-3 rounded-lg border p-3">
      <div className="flex items-center gap-2">
        <ShieldCheckIcon className="size-4" />
        <h2 className="text-sm font-medium">Worker approvals</h2>
        <Badge variant="outline">{setup?.running === true ? "Bridge running" : "Off"}</Badge>
      </div>

      {(approvals?.approvals ?? []).map((approval) => (
        <div
          key={approval.id}
          className="flex flex-wrap items-center gap-2 rounded border bg-muted/40 p-2 text-sm"
        >
          <Badge>{approvalKindLabel(approval.kind)}</Badge>
          <span className="font-medium">{agentName(approval.agentId)}</span>
          <code className="min-w-0 flex-1 truncate font-mono text-xs">
            {approval.title}: {approval.detail}
          </code>
          <Button
            size="sm"
            onClick={() =>
              void respond({ environmentId, input: { id: approval.id, decision: "allow" } })
            }
          >
            <CheckIcon className="size-3.5" /> Allow
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              void respond({ environmentId, input: { id: approval.id, decision: "deny" } })
            }
          >
            <XIcon className="size-3.5" /> Deny
          </Button>
        </div>
      ))}
      {approvals !== null && approvals.approvals.length === 0 ? (
        <p className="text-xs text-muted-foreground">No worker actions waiting.</p>
      ) : null}

      {setup?.running === true ? (
        <div className="flex flex-col gap-1 text-xs">
          <p className="text-muted-foreground">
            Workers on this computer reach T3 at{" "}
            <RedactedSensitiveText value={setup.url} {...HOST_URL_REDACT_PROPS} />. The token is
            kept across restarts in an owner-only file and is never shown here.
          </p>
          <ol className="flex list-decimal flex-col gap-1 pl-4">
            {workerSetupSteps(setup, machineName).map((step) => (
              <li key={step.command}>
                <span className="text-muted-foreground">{step.label}</span>
                <pre className="mt-0.5 overflow-auto rounded bg-muted p-1.5 font-mono">
                  <RedactedSensitiveText
                    value={step.command}
                    {...PATH_REDACT_PROPS}
                    className="whitespace-pre-wrap break-all"
                  />
                </pre>
              </li>
            ))}
            <li className="text-muted-foreground">
              Turn on project hooks for each repository the worker runs below. Commit
              .cursor/hooks.json if the worker uses its own checkout.
            </li>
          </ol>
        </div>
      ) : (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>
            Ask in T3 before worker agents run commands or edit files (Cursor project hooks).
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              void start({ environmentId, input: { start: true } }).then((result) => {
                if (result._tag === "Success") setSetupOverride(result.value);
              })
            }
          >
            Enable worker approvals
          </Button>
        </div>
      )}

      {setup?.running === true && repoRoots.length > 0 ? (
        <div className="flex flex-col gap-1">
          {repoRoots.map((repoRoot) => (
            <ProjectHooksRow key={repoRoot} environmentId={environmentId} repoRoot={repoRoot} />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function ProjectHooksRow({
  environmentId,
  repoRoot,
}: {
  readonly environmentId: EnvironmentId;
  readonly repoRoot: string;
}) {
  const stateAtom = useMemo(
    () => cursorProjectHooksState({ environmentId, input: { repoRoot } }),
    [environmentId, repoRoot],
  );
  const fetched = Option.getOrNull(AsyncResult.value(useAtomValue(stateAtom)));
  const [enabledOverride, setEnabledOverride] = useState<boolean | null>(null);
  const enabled = enabledOverride ?? fetched?.enabled === true;
  const setHooks = useAtomCommand(cursorProjectHooksSet);
  return (
    <label className="flex items-center gap-2 text-xs">
      <Switch
        aria-label="Project hooks for repository"
        checked={enabled}
        disabled={fetched === null && enabledOverride === null}
        onCheckedChange={(next) =>
          void setHooks({ environmentId, input: { repoRoot, enabled: next } }).then((result) => {
            if (result._tag === "Success") setEnabledOverride(result.value.enabled);
          })
        }
      />
      <RedactedSensitiveText value={repoRoot} {...PATH_REDACT_PROPS} className="truncate" />
    </label>
  );
}
