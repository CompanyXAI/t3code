import type { CursorMachineAction, CursorMachineState, EnvironmentId } from "@t3tools/contracts";
import { ProviderInstanceId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useMemo, useState } from "react";

import { cursorMachineAction, cursorMachineState } from "../../state/cursorAgents";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatEnvironmentQueryError } from "../../state/query";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { RedactedSensitiveText } from "../settings/RedactedSensitiveText";
import { RedactedFreeText } from "../settings/RedactedFreeText";
import {
  isRedactionRevealed,
  redactionItemKey,
  useRedactionState,
} from "../settings/redactionReveal";

const CHECK_LABEL: Record<CursorMachineState["check"], string> = {
  match: "CLI profile signed in",
  cliSignedOut: "CLI profile signed out",
  sdkEmailUnknown: "Account email unknown",
  mismatch: "Wrong account in CLI profile",
};

/**
 * CLI profile and worker controls of one Cursor account on this machine:
 * sign in/out of the instance's own CLI profile, run a worker under it, and
 * install a hidden logon task. Worker actions stay disabled until the
 * profile's account matches the instance's account.
 */
export function CursorMachinePanel({
  environmentId,
  instanceId,
  defaultMachine,
}: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: string;
  readonly defaultMachine: string;
}) {
  const stateAtom = useMemo(
    () =>
      cursorMachineState({
        environmentId,
        input: { instanceId: ProviderInstanceId.make(instanceId), action: "status" },
      }),
    [environmentId, instanceId],
  );
  const result = useAtomValue(stateAtom);
  const act = useAtomCommand(cursorMachineAction);
  const [override, setOverride] = useState<CursorMachineState | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState(defaultMachine);
  const [workerDir, setWorkerDir] = useState("");
  const [labels, setLabels] = useState("");
  const redaction = useRedactionState();
  // Typed machine names and folders blur like shown ones; focusing the field reveals it.
  const fieldBlur = (category: "machine" | "path", value: string) =>
    value.trim() === "" ||
    isRedactionRevealed(redaction, category, redactionItemKey(category, value.trim()))
      ? undefined
      : "blur-xs focus:blur-none";

  const polled = Option.getOrNull(AsyncResult.value(result));
  const state = override ?? polled;
  const worker = {
    name: name.trim(),
    workerDir: workerDir.trim(),
    labels: labels
      .split(/[\s,]+/)
      .map((label) => label.trim())
      .filter((label) => label.length > 0),
  };
  const [actionError, setActionError] = useState<string | null>(null);
  const run = (action: CursorMachineAction) => {
    setBusy(true);
    setActionError(null);
    void act({
      environmentId,
      input: {
        instanceId: ProviderInstanceId.make(instanceId),
        action,
        ...(action === "startWorker" || action === "installLogonTask" ? { worker } : {}),
      },
    })
      .then((settled) => {
        if (AsyncResult.isFailure(settled)) {
          setActionError(formatEnvironmentQueryError(settled.cause));
          return;
        }
        if (!AsyncResult.isSuccess(settled)) return;
        setOverride(settled.value);
        if (settled.value.loginUrl !== null)
          window.open(settled.value.loginUrl, "_blank", "noopener");
      })
      .finally(() => setBusy(false));
  };
  if (state === null) {
    // Never hide the CLI sign-in while the status check is slow or failed.
    const failed = AsyncResult.isFailure(result);
    return (
      <div className="flex flex-wrap items-center gap-2 border-t pt-2 text-xs">
        <span className={failed ? "text-destructive-foreground" : "text-muted-foreground"}>
          {failed ? "CLI status could not be checked." : "Checking CLI login…"}
        </span>
        {actionError !== null ? (
          <span role="alert" className="text-destructive-foreground">
            <RedactedFreeText text={actionError} known={{ machines: [defaultMachine] }} />
          </span>
        ) : null}
        <Button size="sm" variant="outline" disabled={busy} onClick={() => run("login")}>
          Sign in CLI
        </Button>
      </div>
    );
  }
  const matched = state.check === "match";
  const workerReady = matched && worker.name.length > 0 && worker.workerDir.length > 0;

  return (
    <div className="flex flex-col gap-2 border-t pt-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Badge variant={matched ? "outline" : "destructive"}>{CHECK_LABEL[state.check]}</Badge>
        {state.cliEmail !== null ? (
          <RedactedSensitiveText
            value={state.cliEmail}
            ariaLabel="Toggle account email visibility"
            revealTooltip="Click to reveal email"
            hideTooltip="Click to hide email"
            className="max-w-full truncate text-xs"
          />
        ) : null}
        <span className="text-muted-foreground">
          {state.standardLogin ? "(standard login)" : "(own home path)"}
        </span>
      </div>
      {actionError !== null ? (
        <span role="alert" className="text-xs text-destructive-foreground">
          <RedactedFreeText text={actionError} known={{ machines: [defaultMachine] }} />
        </span>
      ) : null}
      {state.problem !== null ? (
        <RedactedFreeText
          className="text-xs text-destructive-foreground"
          text={state.problem}
          known={{ machines: [defaultMachine, worker.name] }}
        />
      ) : null}
      <div className="flex flex-wrap gap-1">
        <Button size="sm" variant="outline" disabled={busy} onClick={() => run("login")}>
          {state.loginPending ? "Open sign-in again" : "Sign in CLI"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy || state.cliEmail === null}
          onClick={() => run("logout")}
        >
          Sign out CLI
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => run("status")}>
          Refresh
        </Button>
      </div>
      <div className="grid gap-1 sm:grid-cols-3">
        <Input
          aria-label="Worker name"
          placeholder="Worker name"
          className={fieldBlur("machine", name)}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Input
          aria-label="Worker folder"
          placeholder="Worker folder (absolute)"
          className={fieldBlur("path", workerDir)}
          value={workerDir}
          onChange={(e) => setWorkerDir(e.target.value)}
        />
        <Input
          aria-label="Worker labels"
          placeholder="Labels key=value"
          value={labels}
          onChange={(e) => setLabels(e.target.value)}
        />
      </div>
      <div className="flex flex-wrap items-center gap-1 text-xs">
        {state.worker.running ? (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => run("stopWorker")}>
            Stop worker
          </Button>
        ) : (
          <Button size="sm" disabled={busy || !workerReady} onClick={() => run("startWorker")}>
            Start worker
          </Button>
        )}
        {state.logonTask ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => run("uninstallLogonTask")}
          >
            Remove logon task
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !workerReady}
            onClick={() => run("installLogonTask")}
          >
            Start at logon
          </Button>
        )}
        <RedactedFreeText
          className="text-muted-foreground"
          known={{ machines: [defaultMachine, worker.name] }}
          text={`${
            state.worker.running
              ? `Worker running (PID ${state.worker.pid})`
              : state.worker.lastExit !== null
                ? `Worker stopped: ${state.worker.lastExit}`
                : "Worker not running from T3"
          }${state.logonTask ? ` · logon task ${state.logonTaskName}` : ""}`}
        />
      </div>
    </div>
  );
}
