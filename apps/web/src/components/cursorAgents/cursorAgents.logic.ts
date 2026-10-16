import type {
  CursorAgentAccount,
  CursorAgentEntry,
  CursorAgentRuntime,
  CursorAgentStatus,
} from "@t3tools/contracts";

export const CURSOR_RUNTIME_OPTIONS: ReadonlyArray<{
  readonly value: CursorAgentRuntime;
  readonly label: string;
  readonly hint: string;
}> = [
  {
    value: "local-worker",
    label: "Local (own worker, visible in Cursor)",
    hint: "Runs on this computer through `agent worker start --name <name>`; listed in cursor.com/agents.",
  },
  {
    value: "local",
    label: "Local (SDK, T3 only)",
    hint: "Runs in a project folder here. Cursor does not show local SDK agents in its agent list.",
  },
  { value: "cloud", label: "Cloud", hint: "Cursor-hosted VM for a GitHub repository." },
  {
    value: "self-hosted-pool",
    label: "Self-hosted pool",
    hint: "A team pool of Self-Hosted Machines (Enterprise).",
  },
  {
    value: "self-hosted-machine",
    label: "Self-hosted machine",
    hint: "One named My Machines worker on another computer.",
  },
];

export function runtimeBadge(entry: Pick<CursorAgentEntry, "runtime" | "environmentName">): {
  /** Kind only (no machine name), for UI that redacts the name separately. */
  readonly kindLabel: string;
  /** Full badge text including machine name; kept for search/tests. */
  readonly label: string;
  readonly environmentName: string | null;
  readonly variant: "success" | "info" | "warning" | "secondary";
} {
  const environmentName =
    entry.environmentName === null || entry.environmentName.trim().length === 0
      ? null
      : entry.environmentName;
  const withEnv = (kindLabel: string) =>
    environmentName === null ? kindLabel : `${kindLabel} · ${environmentName}`;
  switch (entry.runtime) {
    case "local":
      return { kindLabel: "Local", label: "Local", environmentName: null, variant: "secondary" };
    case "local-worker":
      return {
        kindLabel: "Local worker",
        label: withEnv("Local worker"),
        environmentName,
        variant: "success",
      };
    case "cloud":
      return { kindLabel: "Cloud", label: "Cloud", environmentName: null, variant: "info" };
    case "self-hosted-pool":
      return {
        kindLabel: "Self-hosted Pool",
        label: withEnv("Self-hosted Pool"),
        environmentName,
        variant: "warning",
      };
    case "self-hosted-machine":
      return {
        kindLabel: "Self-hosted Machine",
        label: withEnv("Self-hosted Machine"),
        environmentName,
        variant: "warning",
      };
  }
}

export function statusBadge(status: CursorAgentStatus): {
  readonly label: string;
  readonly variant: "success" | "error" | "info" | "outline";
} {
  switch (status) {
    case "running":
      return { label: "Running", variant: "info" };
    case "finished":
      return { label: "Finished", variant: "success" };
    case "error":
      return { label: "Error", variant: "error" };
    case "unknown":
      return { label: "Unknown", variant: "outline" };
  }
}

/** "acme/app" from a GitHub URL; the input when it isn't one. */
export function repoLabel(url: string): string {
  const match = /github\.com[/:]([^/]+\/[^/.]+)/.exec(url);
  return match?.[1] ?? url;
}

export type RuntimeFilter = "all" | "local" | "cloud" | "self-hosted";

export function matchesRuntimeFilter(entry: CursorAgentEntry, filter: RuntimeFilter): boolean {
  if (filter === "all") return true;
  if (filter === "local") return entry.runtime === "local" || entry.runtime === "local-worker";
  if (filter === "cloud") return entry.runtime === "cloud";
  return entry.runtime === "self-hosted-pool" || entry.runtime === "self-hosted-machine";
}

export interface LaunchDraft {
  readonly instanceId: string;
  readonly runtime: CursorAgentRuntime;
  readonly name: string;
  readonly prompt: string;
  readonly cwd: string;
  readonly repoUrl: string;
  readonly environmentName: string;
}

/** The first problem that keeps a launch draft from being sent, if any. */
export function launchDraftProblem(
  draft: LaunchDraft,
  blockedAccounts: ReadonlyMap<string, string> = new Map(),
): string | null {
  if (draft.instanceId.length === 0) return "Choose a Cursor account.";
  const blocked = blockedAccounts.get(draft.instanceId);
  if (blocked !== undefined) return blocked;
  if (draft.prompt.trim().length === 0) return "Describe the task.";
  if (draft.runtime === "local") {
    return draft.cwd.trim().length === 0 ? "Choose a project folder." : null;
  }
  if (draft.repoUrl.trim().length === 0) return "Enter the repository URL.";
  if (
    (draft.runtime === "local-worker" || draft.runtime === "self-hosted-machine") &&
    draft.environmentName.trim().length === 0
  ) {
    return "Enter the worker name (agent worker start --name).";
  }
  return null;
}

export function parseMachineNames(value: string): ReadonlyArray<string> {
  return value
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

/** Shell steps shown to set up a worker on this computer. */
export function workerSetupSteps(
  setup: {
    readonly envFile: string | null;
    readonly urlEnv: string;
    readonly tokenEnv: string;
  },
  machineName: string,
): ReadonlyArray<{ readonly label: string; readonly command: string }> {
  if (setup.envFile === null) return [];
  const name = machineName.trim().length === 0 ? "<machine-name>" : machineName.trim();
  const quoted = `'${setup.envFile.replaceAll("'", `'\\''`)}'`;
  return [
    {
      label: `Load ${setup.urlEnv} and ${setup.tokenEnv} (owner-only file, token stays on disk)`,
      command: `set -a; . ${quoted}; set +a`,
    },
    { label: "Start the worker in the same shell", command: `agent worker start --name ${name}` },
  ];
}

export const approvalKindLabel = (kind: string): string =>
  kind === "command"
    ? "Command"
    : kind === "file-change"
      ? "File change"
      : kind === "file-read"
        ? "File read"
        : "Tool";

export interface CursorAccountMachine {
  readonly name: string;
  readonly runtime: "local-worker" | "self-hosted-machine" | "self-hosted-pool";
  readonly agents: number;
}

export interface CursorAccountOverview {
  readonly instanceId: string;
  readonly label: string;
  readonly email: string | null;
  /** Why this account cannot launch right now; null when it can. */
  readonly problem: string | null;
  /** Labels of other instances signed in to the same Cursor account. */
  readonly sharedWith: ReadonlyArray<string>;
  readonly machines: ReadonlyArray<CursorAccountMachine>;
  readonly agents: number;
  /** Local agents every account on this computer shares. */
  readonly sharedAgents: number;
  /** Last sync of this account's agent index; null before the first one. */
  readonly syncedAt: number | null;
  readonly syncing: boolean;
}

/** Shown under an account: when its agents were last synced. */
export function syncLabel(syncedAt: number | null, syncing: boolean): string {
  if (syncedAt === null) return syncing ? "First sync running…" : "Not synced yet";
  const time = new Date(syncedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  // Routine deltas run every few seconds; only a long-running sync is worth mentioning.
  const overdue = Date.now() - syncedAt > 2 * 60 * 1000;
  return syncing && overdue ? `Synced ${time} · updating…` : `Synced ${time}`;
}

/** Local agents live in the store every login on this computer shares. */
export const SHARED_ACCOUNTS_LABEL = "Geteilt (alle Accounts)";

/** One row per Cursor instance: who is signed in, what fails, where it runs. */
export function accountOverview(
  accounts: ReadonlyArray<CursorAgentAccount>,
  entries: ReadonlyArray<CursorAgentEntry>,
  failures: ReadonlyArray<{ readonly instanceId: string; readonly message: string }>,
): ReadonlyArray<CursorAccountOverview> {
  const labelOf = (id: string) => accounts.find((a) => a.instanceId === id)?.label ?? id;
  return accounts.map((account) => {
    const own = entries.filter(
      (entry) => entry.instanceId === account.instanceId && entry.sharedAcrossAccounts !== true,
    );
    const shared = entries.filter((entry) => entry.sharedAcrossAccounts === true).length;
    const machines = new Map<string, CursorAccountMachine>();
    for (const entry of own) {
      if (
        entry.environmentName === null ||
        (entry.runtime !== "local-worker" &&
          entry.runtime !== "self-hosted-machine" &&
          entry.runtime !== "self-hosted-pool")
      ) {
        continue;
      }
      const key = `${entry.runtime}:${entry.environmentName}`;
      const current = machines.get(key);
      machines.set(key, {
        name: entry.environmentName,
        runtime: entry.runtime,
        agents: (current?.agents ?? 0) + 1,
      });
    }
    const failure = failures.find((item) => item.instanceId === account.instanceId);
    return {
      instanceId: account.instanceId,
      label: account.label,
      email: account.email ?? null,
      problem: failure?.message ?? null,
      sharedWith: (account.sharedWith ?? []).map(labelOf),
      machines: [...machines.values()].toSorted((a, b) => b.agents - a.agents),
      agents: own.length,
      sharedAgents: shared,
      syncedAt: account.syncedAt ?? null,
      syncing: account.syncing ?? false,
    };
  });
}

/** Accounts that must not launch, with the reason shown in the form. */
export function blockedAccounts(
  overview: ReadonlyArray<CursorAccountOverview>,
): ReadonlyMap<string, string> {
  return new Map(
    overview
      .filter((account) => account.problem !== null)
      .map((account) => [account.instanceId, `${account.label}: ${account.problem}`]),
  );
}

/** Workers this account has used for the given runtime, for the worker picker. */
export function knownWorkers(
  overview: ReadonlyArray<CursorAccountOverview>,
  instanceId: string,
  runtime: CursorAgentRuntime,
): ReadonlyArray<string> {
  return (overview.find((account) => account.instanceId === instanceId)?.machines ?? [])
    .filter((machine) => machine.runtime === runtime)
    .map((machine) => machine.name);
}

/** Joins consecutive streamed deltas of the same kind (assistant text, thinking) into one line. */
export function mergeStreamLines<L extends { readonly kind: string; readonly text: string }>(
  lines: ReadonlyArray<L>,
): ReadonlyArray<{ readonly kind: string; readonly text: string }> {
  const merged: Array<{ kind: string; text: string }> = [];
  for (const line of lines) {
    const last = merged.at(-1);
    if (
      last !== undefined &&
      last.kind === line.kind &&
      (line.kind === "assistant" || line.kind === "thinking")
    ) {
      last.text += line.text;
    } else {
      merged.push({ kind: line.kind, text: line.text });
    }
  }
  return merged;
}
