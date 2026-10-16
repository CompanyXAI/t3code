import type { CursorAgentEntry, CursorAgentRuntime, EnvironmentId } from "@t3tools/contracts";
import { ProviderInstanceId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import {
  LaptopIcon,
  PlayIcon,
  SendIcon,
  ServerIcon,
  ServerCogIcon,
  SquareIcon,
} from "lucide-react";
import { useMemo, useState } from "react";

import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import {
  cursorAgentFollowUp,
  cursorAgentLaunch,
  cursorAgentList,
  cursorAgentLog,
  cursorAgentStop,
} from "../../state/cursorAgents";
import { useProjects } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { formatEnvironmentQueryError } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarInset } from "../ui/sidebar";
import { Textarea } from "../ui/textarea";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import {
  MACHINE_NAME_REDACT_PROPS,
  RedactedSensitiveText,
} from "../settings/RedactedSensitiveText";
import { RedactedFreeText } from "../settings/RedactedFreeText";
import { redactFreeText } from "../settings/redactFreeText";
import { useRedactionState } from "../settings/redactionReveal";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { CursorMachinePanel } from "./CursorMachinePanel";
import { CursorWorkerApprovalsPanel } from "./CursorWorkerApprovalsPanel";
import {
  syncLabel,
  SHARED_ACCOUNTS_LABEL,
  accountOverview,
  blockedAccounts,
  type CursorAccountOverview,
  knownWorkers,
  mergeStreamLines,
  CURSOR_RUNTIME_OPTIONS,
  type LaunchDraft,
  launchDraftProblem,
  matchesRuntimeFilter,
  parseMachineNames,
  repoLabel,
  type RuntimeFilter,
  runtimeBadge,
  statusBadge,
} from "./cursorAgents.logic";

const MACHINE_NAMES_KEY = "t3code:cursor-agents:own-machines";

function readMachineNames(): string {
  try {
    return globalThis.localStorage?.getItem(MACHINE_NAMES_KEY) ?? "";
  } catch {
    return "";
  }
}

export function CursorAgentsPage() {
  const environmentId = usePrimaryEnvironmentId();
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <h1 className="text-sm font-medium">Cursor agents</h1>
        </WorkspacePageHeader>
        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="wide">
            {environmentId === null ? (
              <p className="text-sm text-muted-foreground">Connect an environment first.</p>
            ) : (
              <CursorAgentsView environmentId={environmentId} />
            )}
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}

function CursorAgentsView({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const projects = useProjects();
  const localCwds = useMemo(
    () =>
      projects
        .filter((project) => project.environmentId === environmentId && project.isScratch !== true)
        .map((project) => project.workspaceRoot),
    [environmentId, projects],
  );
  const [machineNamesText, setMachineNamesText] = useState(readMachineNames);
  const ownMachineNames = useMemo(() => parseMachineNames(machineNamesText), [machineNamesText]);
  const listAtom = useMemo(
    () => cursorAgentList({ environmentId, input: { localCwds, ownMachineNames } }),
    [environmentId, localCwds, ownMachineNames],
  );
  const listResult = useAtomValue(listAtom);
  const list = Option.getOrNull(AsyncResult.value(listResult));
  const [filter, setFilter] = useState<RuntimeFilter>("all");
  const [selected, setSelected] = useState<CursorAgentEntry | null>(null);
  const [launching, setLaunching] = useState(false);

  const entries = (list?.entries ?? []).filter((entry) => matchesRuntimeFilter(entry, filter));
  const overview = useMemo(
    () => (list === null ? [] : accountOverview(list.accounts, list.entries, list.failures)),
    [list],
  );
  const accountLabel = (instanceId: string) =>
    list?.accounts.find((account) => account.instanceId === instanceId)?.label ?? instanceId;

  return (
    <div className="flex flex-col gap-4 py-4">
      <div className="flex flex-wrap items-center gap-2">
        <ToggleGroup
          value={[filter]}
          onValueChange={(value) => {
            const next = value[0];
            if (next === "all" || next === "local" || next === "cloud" || next === "self-hosted") {
              setFilter(next);
            }
          }}
        >
          <Toggle value="all">All</Toggle>
          <Toggle value="local">Local</Toggle>
          <Toggle value="cloud">Cloud</Toggle>
          <Toggle value="self-hosted">Self-hosted</Toggle>
        </ToggleGroup>
        <Input
          aria-label="Worker names on this computer"
          className="w-64"
          placeholder="Own worker names, e.g. daniels-mbp"
          value={machineNamesText}
          onChange={(event) => {
            setMachineNamesText(event.target.value);
            try {
              globalThis.localStorage?.setItem(MACHINE_NAMES_KEY, event.target.value);
            } catch {
              // Private mode: keep the value for this session only.
            }
          }}
        />
        <div className="flex-1" />
        <Button onClick={() => setLaunching((open) => !open)}>
          <PlayIcon className="size-4" /> Start agent
        </Button>
      </div>

      {listResult._tag === "Failure" ? (
        <p className="text-sm text-destructive-foreground">
          {formatEnvironmentQueryError(listResult.cause)}
        </p>
      ) : null}
      {list !== null && list.accounts.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Enable a Cursor provider in Settings → Providers. Each Cursor instance is one account.
        </p>
      ) : null}

      {overview.length > 0 ? (
        <AccountOverview
          overview={overview}
          environmentId={environmentId}
          defaultMachine={ownMachineNames[0] ?? ""}
        />
      ) : null}

      <CursorWorkerApprovalsPanel
        environmentId={environmentId}
        entries={list?.entries ?? []}
        repoRoots={localCwds}
        machineName={ownMachineNames[0] ?? ""}
      />

      {launching && list !== null ? (
        <LaunchForm
          environmentId={environmentId}
          accounts={list.accounts}
          overview={overview}
          localCwds={localCwds}
          defaultMachine={ownMachineNames[0] ?? ""}
          onDone={() => setLaunching(false)}
        />
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <ul className="flex flex-col divide-y rounded-lg border" aria-label="Cursor agents">
          {list === null && listResult.waiting ? (
            <li className="p-3 text-sm text-muted-foreground">Loading Cursor agents…</li>
          ) : null}
          {list !== null && entries.length === 0 ? (
            <li className="p-3 text-sm text-muted-foreground">No agents for this filter.</li>
          ) : null}
          {entries.map((entry) => {
            const runtime = runtimeBadge(entry);
            const status = statusBadge(entry.status);
            const isSelected =
              selected?.agentId === entry.agentId && selected.instanceId === entry.instanceId;
            return (
              <li key={`${entry.instanceId}:${entry.agentId}`}>
                <button
                  type="button"
                  className={cn(
                    "flex w-full flex-col gap-1 p-3 text-left hover:bg-accent/50",
                    isSelected && "bg-accent",
                  )}
                  onClick={() => setSelected(entry)}
                >
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{entry.name}</span>
                    <div className="flex-1" />
                    <Badge variant={runtime.variant} className="max-w-full gap-0.5 truncate">
                      <span>{runtime.kindLabel}</span>
                      {runtime.environmentName ? (
                        <>
                          <span aria-hidden="true"> · </span>
                          <RedactedSensitiveText
                            value={runtime.environmentName}
                            {...MACHINE_NAME_REDACT_PROPS}
                            className="text-inherit"
                          />
                        </>
                      ) : null}
                    </Badge>
                    <Badge variant={status.variant}>{status.label}</Badge>
                  </div>
                  <div className="flex gap-2 text-xs text-muted-foreground">
                    <span>
                      {entry.sharedAcrossAccounts === true
                        ? SHARED_ACCOUNTS_LABEL
                        : accountLabel(entry.instanceId)}
                    </span>
                    {entry.repos.map((repo) => (
                      <span key={repo}>{repoLabel(repo)}</span>
                    ))}
                    {entry.cwd !== null ? <span className="truncate">{entry.cwd}</span> : null}
                    {entry.createdByT3 ? <span>· from T3</span> : null}
                  </div>
                  {entry.summary.length > 0 ? (
                    <p className="line-clamp-2 text-xs text-muted-foreground">{entry.summary}</p>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
        {selected === null ? (
          <div className="rounded-lg border p-3 text-sm text-muted-foreground">
            Select an agent to follow its latest run.
          </div>
        ) : (
          <AgentDetail
            key={`${selected.instanceId}:${selected.agentId}`}
            environmentId={environmentId}
            entry={selected}
          />
        )}
      </div>
    </div>
  );
}

function AgentDetail({
  environmentId,
  entry,
}: {
  readonly environmentId: EnvironmentId;
  readonly entry: CursorAgentEntry;
}) {
  const target = useMemo(
    () => ({
      instanceId: entry.instanceId,
      agentId: entry.agentId,
      ...(entry.cwd === null ? {} : { cwd: entry.cwd }),
    }),
    [entry.agentId, entry.cwd, entry.instanceId],
  );
  const logAtom = useMemo(
    () => cursorAgentLog({ environmentId, input: target }),
    [environmentId, target],
  );
  const log = useAtomValue(logAtom);
  const lines = mergeStreamLines(Option.getOrElse(AsyncResult.value(log), () => []));
  const followUp = useAtomCommand(cursorAgentFollowUp);
  const stop = useAtomCommand(cursorAgentStop);
  const [prompt, setPrompt] = useState("");

  return (
    <div className="flex min-h-80 flex-col gap-2 rounded-lg border p-3">
      <div className="flex items-center gap-2">
        <span className="truncate text-sm font-medium">{entry.name}</span>
        <div className="flex-1" />
        <Button
          size="sm"
          variant="outline"
          disabled={entry.status !== "running"}
          onClick={() => void stop({ environmentId, input: target })}
        >
          <SquareIcon className="size-3.5" /> Stop
        </Button>
      </div>
      <pre
        aria-label="Agent stream"
        className="max-h-96 min-h-40 flex-1 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 font-mono text-xs"
      >
        {lines.length === 0
          ? log._tag === "Failure"
            ? formatEnvironmentQueryError(log.cause)
            : "Waiting for output…"
          : lines.map((line, index) => (
              // oxlint-disable-next-line react/no-array-index-key -- log lines have no id and only append
              <div key={index} className={cn(line.kind === "thinking" && "text-muted-foreground")}>
                <span className="text-muted-foreground">{line.kind} › </span>
                {line.text}
              </div>
            ))}
      </pre>
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (prompt.trim().length === 0) return;
          void followUp({ environmentId, input: { ...target, prompt } }).then(() => setPrompt(""));
        }}
      >
        <Input
          aria-label="Follow-up"
          placeholder="Send a follow-up…"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
        />
        <Button type="submit" size="icon" aria-label="Send follow-up">
          <SendIcon className="size-4" />
        </Button>
      </form>
    </div>
  );
}

function LaunchForm({
  environmentId,
  accounts,
  overview,
  localCwds,
  defaultMachine,
  onDone,
}: {
  readonly environmentId: EnvironmentId;
  readonly accounts: ReadonlyArray<{ readonly instanceId: string; readonly label: string }>;
  readonly overview: ReadonlyArray<CursorAccountOverview>;
  readonly localCwds: ReadonlyArray<string>;
  readonly defaultMachine: string;
  readonly onDone: () => void;
}) {
  const launch = useAtomCommand(cursorAgentLaunch);
  const blocked = useMemo(() => blockedAccounts(overview), [overview]);
  const [draft, setDraft] = useState<LaunchDraft>({
    instanceId: accounts.find((account) => !blocked.has(account.instanceId))?.instanceId ?? "",
    runtime: "local-worker",
    name: "",
    prompt: "",
    cwd: localCwds[0] ?? "",
    repoUrl: "",
    environmentName: defaultMachine,
  });
  const problem = launchDraftProblem(draft, blocked);
  const workers = knownWorkers(overview, draft.instanceId, draft.runtime);
  const emailOf = (instanceId: string) =>
    overview.find((account) => account.instanceId === instanceId)?.email ?? null;
  const runtimeOption = CURSOR_RUNTIME_OPTIONS.find((option) => option.value === draft.runtime);
  const set = (patch: Partial<LaunchDraft>) => setDraft((current) => ({ ...current, ...patch }));

  return (
    <form
      aria-label="Start Cursor agent"
      className="grid gap-3 rounded-lg border p-3 sm:grid-cols-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (problem !== null) return;
        void launch({
          environmentId,
          input: {
            instanceId: ProviderInstanceId.make(draft.instanceId),
            name: draft.name.trim().length === 0 ? draft.prompt.slice(0, 60) : draft.name,
            prompt: draft.prompt,
            runtime: draft.runtime,
            ...(draft.runtime === "local" ? { cwd: draft.cwd } : { repoUrl: draft.repoUrl }),
            ...(draft.environmentName.trim().length === 0 || draft.runtime === "local"
              ? {}
              : { environmentName: draft.environmentName.trim() }),
          },
        }).then((result) => {
          if (result._tag === "Success") onDone();
        });
      }}
    >
      <Select
        value={draft.instanceId}
        onValueChange={(value) => set({ instanceId: String(value) })}
      >
        <SelectTrigger aria-label="Cursor account">
          <SelectValue>
            <span className="inline-flex min-w-0 items-center gap-1">
              <span className="truncate">
                {accounts.find((account) => account.instanceId === draft.instanceId)?.label ??
                  "Account"}
              </span>
              {emailOf(draft.instanceId) ? (
                <>
                  <span aria-hidden="true">·</span>
                  <RedactedSensitiveText
                    value={emailOf(draft.instanceId)}
                    ariaLabel="Toggle account email visibility"
                    revealTooltip="Click to reveal email"
                    hideTooltip="Click to hide email"
                    className="truncate text-inherit"
                  />
                </>
              ) : null}
            </span>
          </SelectValue>
        </SelectTrigger>
        <SelectPopup>
          {accounts.map((account) => (
            <SelectItem
              key={account.instanceId}
              value={account.instanceId}
              disabled={blocked.has(account.instanceId)}
            >
              <span className="inline-flex min-w-0 items-center gap-1">
                <span className="truncate">{account.label}</span>
                {emailOf(account.instanceId) ? (
                  <>
                    <span aria-hidden="true">·</span>
                    <RedactedSensitiveText
                      value={emailOf(account.instanceId)}
                      ariaLabel="Toggle account email visibility"
                      revealTooltip="Click to reveal email"
                      hideTooltip="Click to hide email"
                      className="truncate text-inherit"
                    />
                  </>
                ) : null}
              </span>
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      <Select
        value={draft.runtime}
        onValueChange={(value) => set({ runtime: value as CursorAgentRuntime })}
      >
        <SelectTrigger aria-label="Runtime">
          <SelectValue>{runtimeOption?.label}</SelectValue>
        </SelectTrigger>
        <SelectPopup>
          {CURSOR_RUNTIME_OPTIONS.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      <p className="text-xs text-muted-foreground sm:col-span-2">{runtimeOption?.hint}</p>
      <datalist id="cursor-known-workers">
        {workers.map((worker) => (
          <option key={worker} value={worker} />
        ))}
      </datalist>
      {draft.runtime === "local" ? (
        <Select value={draft.cwd} onValueChange={(value) => set({ cwd: String(value) })}>
          <SelectTrigger aria-label="Project folder">
            <SelectValue>{draft.cwd.length === 0 ? "Project folder" : draft.cwd}</SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {localCwds.map((cwd) => (
              <SelectItem key={cwd} value={cwd}>
                {cwd}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      ) : (
        <Input
          aria-label="Repository URL"
          placeholder="https://github.com/owner/repo"
          value={draft.repoUrl}
          onChange={(event) => set({ repoUrl: event.target.value })}
        />
      )}
      {draft.runtime === "local-worker" ||
      draft.runtime === "self-hosted-machine" ||
      draft.runtime === "self-hosted-pool" ? (
        <Input
          aria-label={draft.runtime === "self-hosted-pool" ? "Pool name" : "Worker name"}
          placeholder={draft.runtime === "self-hosted-pool" ? "Pool (default)" : "Worker name"}
          value={draft.environmentName}
          list="cursor-known-workers"
          onChange={(event) => set({ environmentName: event.target.value })}
        />
      ) : (
        <div />
      )}
      <Input
        aria-label="Agent name"
        className="sm:col-span-2"
        placeholder="Name (shown in Cursor with a [T3 · …] prefix)"
        value={draft.name}
        onChange={(event) => set({ name: event.target.value })}
      />
      <Textarea
        aria-label="Task"
        className="sm:col-span-2"
        placeholder="What should the agent do?"
        value={draft.prompt}
        onChange={(event) => set({ prompt: event.target.value })}
      />
      <div className="flex items-center gap-2 sm:col-span-2">
        <span className="text-xs text-muted-foreground">{problem}</span>
        <div className="flex-1" />
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={problem !== null}>
          Start
        </Button>
      </div>
    </form>
  );
}

const MACHINE_KIND_LABEL: Record<CursorAccountOverview["machines"][number]["runtime"], string> = {
  "local-worker": "Worker on this computer",
  "self-hosted-machine": "Self-hosted",
  "self-hosted-pool": "Pool",
};

const MACHINE_KIND_ICON = {
  "local-worker": LaptopIcon,
  "self-hosted-machine": ServerIcon,
  "self-hosted-pool": ServerCogIcon,
} as const satisfies Record<CursorAccountOverview["machines"][number]["runtime"], unknown>;

/** "Runs on" glyph: the kind lives in a tooltip with blurred machine and account. */
function MachineRunsOnIcon(props: {
  readonly runtime: CursorAccountOverview["machines"][number]["runtime"];
  readonly machine: string;
  readonly account: string;
}) {
  const redaction = useRedactionState();
  const Icon = MACHINE_KIND_ICON[props.runtime];
  const known = { machines: [props.machine], accounts: [props.account] };
  const lines = [
    `Runs on: ${MACHINE_KIND_LABEL[props.runtime]}`,
    `Machine: ${props.machine}`,
    `Account: ${props.account}`,
  ].map((line) => redactFreeText(line, redaction, known));
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className="inline-flex shrink-0 items-center"
            aria-label={`Runs on ${MACHINE_KIND_LABEL[props.runtime]}`}
          />
        }
      >
        <Icon aria-hidden className="size-3" />
      </TooltipTrigger>
      <TooltipPopup side="top" className="whitespace-pre-line">
        {lines.join("\n")}
      </TooltipPopup>
    </Tooltip>
  );
}

/** Every Cursor account with its login, warnings and the machines it runs on. */
function AccountOverview({
  overview,
  environmentId,
  defaultMachine,
}: {
  readonly overview: ReadonlyArray<CursorAccountOverview>;
  readonly environmentId: EnvironmentId;
  readonly defaultMachine: string;
}) {
  return (
    <section aria-label="Cursor accounts" className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
      {overview.map((account) => (
        <div key={account.instanceId} className="flex flex-col gap-1 rounded-lg border p-3 text-sm">
          <div className="flex items-center gap-2">
            <span className="font-medium">{account.label}</span>
            <span className="text-muted-foreground">
              {account.agents} agents
              {account.sharedAgents > 0 ? ` + ${account.sharedAgents} shared` : ""}
            </span>
          </div>
          {account.email === null ? (
            <span className="text-xs text-muted-foreground">Not signed in (SDK)</span>
          ) : (
            <RedactedSensitiveText
              value={account.email}
              ariaLabel="Toggle account email visibility"
              revealTooltip="Click to reveal email"
              hideTooltip="Click to hide email"
              className="max-w-full truncate text-xs"
            />
          )}
          <span className="text-xs text-muted-foreground">
            {syncLabel(account.syncedAt, account.syncing)}
          </span>
          {account.problem !== null ? (
            <RedactedFreeText
              className="text-xs text-destructive-foreground"
              text={account.problem}
            />
          ) : null}
          {account.sharedWith.length > 0 ? (
            <span className="text-xs text-warning-foreground">
              <RedactedFreeText
                text={`Same Cursor account as ${account.sharedWith.join(", ")}`}
                known={{ accounts: account.sharedWith }}
              />
            </span>
          ) : null}
          <div className="flex flex-wrap gap-1 pt-1">
            {account.machines.map((machine) => (
              <Badge
                key={`${machine.runtime}:${machine.name}`}
                variant="outline"
                className="max-w-full gap-0.5 truncate"
              >
                <MachineRunsOnIcon
                  runtime={machine.runtime}
                  machine={machine.name}
                  account={account.label}
                />
                <RedactedSensitiveText
                  value={machine.name}
                  {...MACHINE_NAME_REDACT_PROPS}
                  className="text-inherit"
                />
                <span className="text-muted-foreground">{machine.agents}</span>
              </Badge>
            ))}
          </div>
          <CursorMachinePanel
            environmentId={environmentId}
            instanceId={account.instanceId}
            defaultMachine={defaultMachine}
          />
        </div>
      ))}
    </section>
  );
}
