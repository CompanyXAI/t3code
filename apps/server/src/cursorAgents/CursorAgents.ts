// @effect-diagnostics nodeBuiltinImport:off - joins the index folder path.
import * as NodeOS from "node:os";
/**
 * Server side of the Cursor agents page: one list of every Cursor agent
 * (local SDK, own-machine worker, Cursor Cloud, Self-Hosted pool/machine)
 * across every enabled Cursor provider instance, plus launch, follow-up,
 * stop and a live stream. Each provider instance is one Cursor account and
 * answers with its own API key.
 *
 * @module server/cursorAgents/CursorAgents
 */
import {
  CursorAgentsError,
  type CursorAgentAccount,
  type CursorAgentEntry,
  type CursorAgentsFollowUpInput,
  type CursorAgentsLaunchInput,
  type CursorAgentsListInput,
  type CursorAgentsListResult,
  type CursorAgentsRunResult,
  type CursorAgentStreamEvent,
  type CursorAgentTarget,
  type CursorMachineInput,
  type CursorMachineState,
  ProviderDriverKind,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as CursorAgentDirectory from "@t3tools/provider-cursor/server/CursorAgentDirectory";
import {
  logonTaskName,
  makeCursorMachine,
  type CursorMachine,
  type CursorMachineDeps,
  cursorWorkerRoot,
} from "@t3tools/provider-cursor/server/CursorMachine";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as NodePath from "node:path";

import * as CursorAgentIndex from "./CursorAgentIndex.ts";

const CURSOR_DRIVER = ProviderDriverKind.make("cursor");

export interface CursorAgentsDeps {
  readonly listInstances: Effect.Effect<ReadonlyArray<ProviderInstance>>;
  readonly directory: CursorAgentDirectory.CursorAgentDirectory;
  /** Test seam for the CLI profile and worker controls. */
  readonly makeMachine?: (
    config: { readonly homePath?: string | undefined },
    deps: CursorMachineDeps,
  ) => CursorMachine;
  /** Server state folder; the agent index is kept there. In memory when omitted. */
  readonly stateDir?: string;
}

/** The instance's name, else its id, as everywhere in T3. */
const instanceLabel = (instance: ProviderInstance): string =>
  instance.displayName?.trim() || instance.instanceId;

const describeCause = (cause: unknown): string => {
  if (
    typeof cause === "object" &&
    cause !== null &&
    "detail" in cause &&
    typeof cause.detail === "string"
  ) {
    return cause.detail;
  }
  const inner =
    typeof cause === "object" && cause !== null && "cause" in cause
      ? (cause as { readonly cause: unknown }).cause
      : cause;
  if (inner instanceof Error && inner.message.length > 0) return inner.message;
  if (cause instanceof Error && cause.message.length > 0) return cause.message;
  return String(inner);
};

export function toContractEntry(
  entry: CursorAgentDirectory.CursorDirectoryEntry,
  sharedAcrossAccounts = false,
): CursorAgentEntry {
  return {
    agentId: entry.agentId,
    instanceId: entry.accountId as ProviderInstanceId,
    ...(sharedAcrossAccounts ? { sharedAcrossAccounts: true } : {}),
    runtime: entry.runtime,
    environmentName: entry.environmentName ?? null,
    name: entry.name,
    summary: entry.summary,
    status: entry.status,
    repos: entry.repos,
    cwd: entry.cwd ?? null,
    createdByT3: entry.createdByT3,
    archived: entry.archived,
    updatedAt: entry.updatedAt,
  };
}

type MachineEntry = { machine: CursorMachine; sdkEmail: string | undefined };
const processMachines = new Map<string, MachineEntry>();

/**
 * One agent index per state folder for the whole server process: `make`
 * runs once per WebSocket connection, but all of them share the snapshots
 * and at most one sync per account.
 */
const processIndexes = new Map<string, CursorAgentIndex.CursorAgentIndex>();

/** On a first-ever sync the page waits this long before showing "syncing". */
const FIRST_SYNC_WAIT_MS = 10_000;

/** Own-worker detection depends on the names entered on the page, so it is applied on read. */
function withOwnMachines(
  entry: CursorAgentDirectory.CursorDirectoryEntry,
  ownMachineNames: ReadonlyArray<string>,
): CursorAgentDirectory.CursorDirectoryEntry {
  if (
    entry.environmentName === undefined ||
    (entry.runtime !== "self-hosted-machine" && entry.runtime !== "local-worker")
  ) {
    return entry;
  }
  const runtime = ownMachineNames.includes(entry.environmentName)
    ? "local-worker"
    : "self-hosted-machine";
  return runtime === entry.runtime
    ? entry
    : { ...entry, runtime, runtimeLabel: CursorAgentDirectory.CURSOR_AGENT_RUNTIME_LABEL[runtime] };
}

export const make = (deps: CursorAgentsDeps) => {
  const index =
    deps.stateDir === undefined
      ? new CursorAgentIndex.CursorAgentIndex(CursorAgentIndex.memoryStorage())
      : (processIndexes.get(deps.stateDir) ??
        processIndexes
          .set(
            deps.stateDir,
            new CursorAgentIndex.CursorAgentIndex(
              CursorAgentIndex.fileStorage(NodePath.join(deps.stateDir, "cursor-agent-index")),
            ),
          )
          .get(deps.stateDir)!);

  const syncFor = (
    account: CursorAgentDirectory.CursorDirectoryAccount,
  ): CursorAgentIndex.CursorIndexSync => ({
    listCloud: (since) => Effect.runPromise(deps.directory.listCloud(account, since)),
    statuses: (agentIds) => Effect.runPromise(deps.directory.cloudStatusesOf(account, agentIds)),
    email: () =>
      Effect.runPromise(
        deps.directory
          .accountEmail(account)
          .pipe(Effect.map((email) => email?.trim().toLowerCase() || null)),
      ),
  });

  const cursorInstances = deps.listInstances.pipe(
    Effect.map((instances) =>
      instances.filter(
        (instance) =>
          instance.driverKind === CURSOR_DRIVER &&
          instance.enabled &&
          instance.agentDirectoryApiKey !== undefined,
      ),
    ),
  );

  const accountOf = (
    instance: ProviderInstance,
    extra: Pick<CursorAgentDirectory.CursorDirectoryAccount, "localCwds" | "ownMachineNames">,
  ) =>
    instance.agentDirectoryApiKey!.pipe(
      Effect.map((apiKey): CursorAgentDirectory.CursorDirectoryAccount => ({
        accountId: instance.instanceId,
        label: instanceLabel(instance),
        apiKey,
        ...extra,
      })),
    );

  const accountFor = (operation: CursorAgentsError["operation"], instanceId: ProviderInstanceId) =>
    cursorInstances.pipe(
      Effect.flatMap((instances) => {
        const instance = instances.find((candidate) => candidate.instanceId === instanceId);
        return instance === undefined
          ? Effect.fail(
              new CursorAgentsError({
                operation,
                detail: `Cursor account ${instanceId} is not enabled.`,
              }),
            )
          : accountOf(instance, {}).pipe(
              Effect.mapError(
                (cause) => new CursorAgentsError({ operation, detail: describeCause(cause) }),
              ),
            );
      }),
    );

  const list = (input: CursorAgentsListInput) =>
    Effect.gen(function* () {
      const instances = yield* cursorInstances;
      const accounts: Array<CursorAgentAccount> = instances.map((instance) => ({
        instanceId: instance.instanceId,
        label: instanceLabel(instance),
      }));
      const failures: Array<CursorAgentsListResult["failures"][number]> = [];
      const ready: Array<CursorAgentDirectory.CursorDirectoryAccount> = [];
      for (const instance of instances) {
        const account = yield* accountOf(instance, {
          ...(input.localCwds === undefined ? {} : { localCwds: input.localCwds }),
          ...(input.ownMachineNames === undefined
            ? {}
            : { ownMachineNames: input.ownMachineNames }),
        }).pipe(Effect.timeout("15 seconds"), Effect.result);
        if (account._tag === "Success") ready.push(account.success);
        else
          failures.push({
            instanceId: instance.instanceId,
            message: describeCause(account.failure),
          });
      }
      // Every account answers from its stored index right away; syncs run in
      // the background, one per account, and only fetch what changed.
      const ownMachineNames = input.ownMachineNames ?? [];
      const perAccount = yield* Effect.forEach(
        ready,
        (account) =>
          Effect.promise(() =>
            index.read(account.accountId, syncFor(account), FIRST_SYNC_WAIT_MS),
          ).pipe(Effect.map((state) => ({ account, state }))),
        { concurrency: "unbounded" },
      );
      const syncState = new Map(
        perAccount.map(({ account, state }) => [account.accountId, state] as const),
      );
      for (const { account, state } of perAccount) {
        if (state.snapshot === undefined && !state.syncing && state.error !== undefined)
          failures.push({
            instanceId: account.accountId as ProviderInstanceId,
            message: `Cursor did not answer for this account: ${state.error}`,
          });
      }
      // Local agents come from this computer's Cursor store, which every
      // login shares and which records no account: they belong to all
      // accounts, are listed once and are opened with the first ready login.
      const localOwner = ready[0];
      const localEntries =
        localOwner === undefined || (input.localCwds ?? []).length === 0
          ? []
          : yield* deps.directory.listLocal(localOwner).pipe(
              Effect.timeout("30 seconds"),
              Effect.orElseSucceed(() => []),
            );
      const cloudEntries = perAccount
        .flatMap(({ state }) => state.snapshot?.entries ?? [])
        .map((entry) => withOwnMachines(entry, ownMachineNames));
      const listed = {
        entries: [
          ...cloudEntries.map((entry) => toContractEntry(entry)),
          ...localEntries.map((entry) => toContractEntry(entry, true)),
        ].toSorted((a, b) => b.updatedAt - a.updatedAt),
      };
      // Show which login each instance really uses, and flag two instances on
      // one account so a launch never silently lands on the wrong account.
      const emails = new Map<string, string | null>();
      const found = yield* Effect.forEach(
        ready,
        (account) =>
          deps.directory.accountEmail(account).pipe(
            Effect.timeout("15 seconds"),
            Effect.orElseSucceed(() => undefined),
            Effect.map(
              (email) => [account.accountId, email?.trim().toLowerCase() || null] as const,
            ),
          ),
        { concurrency: "unbounded" },
      );
      for (const [id, email] of found) emails.set(id, email);
      const withIdentity = accounts.map((account) => {
        const email = emails.get(account.instanceId) ?? null;
        const sharedWith =
          email === null
            ? []
            : accounts
                .filter(
                  (other) =>
                    other.instanceId !== account.instanceId &&
                    emails.get(other.instanceId) === email,
                )
                .map((other) => other.instanceId);
        const state = syncState.get(account.instanceId);
        return {
          ...account,
          email,
          ...(sharedWith.length === 0 ? {} : { sharedWith }),
          syncedAt: state?.snapshot?.syncedAt ?? null,
          syncing: state?.syncing ?? false,
        };
      });
      return {
        accounts: withIdentity,
        entries: listed.entries,
        failures,
      } satisfies CursorAgentsListResult;
    });

  const launch = (input: CursorAgentsLaunchInput) =>
    Effect.gen(function* () {
      const account = yield* accountFor("launch", input.instanceId);
      const target =
        input.runtime === "local"
          ? input.cwd === undefined
            ? undefined
            : ({ runtime: "local", cwd: input.cwd } as const)
          : input.repoUrl === undefined
            ? undefined
            : ({
                runtime: input.runtime,
                repoUrl: input.repoUrl,
                ...(input.startingRef === undefined ? {} : { startingRef: input.startingRef }),
                ...(input.environmentName === undefined
                  ? {}
                  : { environmentName: input.environmentName }),
                ...(input.autoCreatePR === undefined ? {} : { autoCreatePR: input.autoCreatePR }),
              } as const);
      if (target === undefined) {
        return yield* new CursorAgentsError({
          operation: "launch",
          detail:
            input.runtime === "local"
              ? "Local agents need a workspace folder."
              : "Cloud and self-hosted agents need a repository URL.",
        });
      }
      if (input.runtime === "local-worker" && input.environmentName === undefined) {
        return yield* new CursorAgentsError({
          operation: "launch",
          detail: "Name the worker on this computer (agent worker start --name <name>).",
        });
      }
      const launched = yield* deps.directory.launch({
        account,
        prompt: input.prompt,
        name: input.name,
        ...(input.model === undefined ? {} : { model: { id: input.model } }),
        target,
      });
      index.markStale(account.accountId);
      return { agentId: launched.agentId, runId: launched.runId } satisfies CursorAgentsRunResult;
    }).pipe(
      Effect.catchTags({
        CursorAgentDirectoryError: (cause) =>
          Effect.fail(new CursorAgentsError({ operation: "launch", detail: describeCause(cause) })),
      }),
    );

  const followUp = (input: CursorAgentsFollowUpInput) =>
    accountFor("followUp", input.instanceId).pipe(
      Effect.flatMap((account) =>
        deps.directory.followUp({
          account,
          agentId: input.agentId,
          prompt: input.prompt,
          ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
        }),
      ),
      Effect.map((run): CursorAgentsRunResult => ({ agentId: run.agentId, runId: run.runId })),
      Effect.catchTags({
        CursorAgentDirectoryError: (cause) =>
          Effect.fail(
            new CursorAgentsError({ operation: "followUp", detail: describeCause(cause) }),
          ),
      }),
    );

  const stop = (input: CursorAgentTarget) =>
    accountFor("stop", input.instanceId).pipe(
      Effect.flatMap((account) =>
        deps.directory.stop({
          account,
          agentId: input.agentId,
          ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
        }),
      ),
      Effect.map((runId): CursorAgentsRunResult => {
        index.markStale(input.instanceId);
        return { agentId: input.agentId, runId: runId ?? null };
      }),
      Effect.catchTags({
        CursorAgentDirectoryError: (cause) =>
          Effect.fail(new CursorAgentsError({ operation: "stop", detail: describeCause(cause) })),
      }),
    );

  const follow = (
    input: CursorAgentTarget,
  ): Stream.Stream<CursorAgentStreamEvent, CursorAgentsError> =>
    Stream.unwrap(
      accountFor("follow", input.instanceId).pipe(
        Effect.map((account) =>
          deps.directory
            .follow({
              account,
              agentId: input.agentId,
              ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
            })
            .pipe(
              Stream.map(CursorAgentDirectory.streamLineOf),
              Stream.mapError(
                (cause) =>
                  new CursorAgentsError({ operation: "follow", detail: describeCause(cause) }),
              ),
            ),
        ),
      ),
    );

  // One machine controller per instance and profile folder for the whole
  // server process, so a running login or worker survives between requests
  // and is seen by every browser connection (each connection builds its own
  // handlers). Injected test machines get a private registry.
  const machines =
    deps.makeMachine === undefined ? processMachines : new Map<string, MachineEntry>();

  const machine = (input: CursorMachineInput) =>
    Effect.gen(function* () {
      const fail = (detail: string) => new CursorAgentsError({ operation: "machine", detail });
      const instances = yield* cursorInstances;
      const instance = instances.find((candidate) => candidate.instanceId === input.instanceId);
      if (instance === undefined) {
        return yield* fail(`Cursor account ${input.instanceId} is not enabled.`);
      }
      const homePath = instance.homePath ?? "";
      // Without an SDK login the email stays unknown: CLI sign-in and status
      // still work, while the guard keeps workers and logon tasks blocked.
      const sdkEmail = yield* accountFor("machine", input.instanceId).pipe(
        Effect.flatMap((account) => deps.directory.accountEmail(account)),
        Effect.orElseSucceed(() => undefined),
      );
      const key = `${input.instanceId}\u0000${homePath}`;
      let entry = machines.get(key);
      if (entry === undefined) {
        const holder: { machine?: CursorMachine; sdkEmail: string | undefined } = { sdkEmail };
        const created = (deps.makeMachine ?? makeCursorMachine)(
          { homePath },
          {
            platform: process.platform,
            environment: process.env,
            home: NodeOS.homedir(),
            // Side by side in T3's state folder, one per instance, apart from the login.
            workerRoot: cursorWorkerRoot(
              deps.stateDir ?? NodePath.join(NodeOS.homedir(), ".t3", "userdata"),
              input.instanceId,
            ),
            sdkEmail: async () => holder.sdkEmail,
          },
        );
        entry = Object.assign(holder, { machine: created });
        machines.set(key, entry);
      }
      entry.sdkEmail = sdkEmail;
      const controller = entry.machine;
      const needWorker = () =>
        input.worker === undefined
          ? Effect.fail(fail("Worker name, folder and labels are required."))
          : Effect.succeed(input.worker);
      const attempt = <A>(run: () => Promise<A>) =>
        Effect.tryPromise({
          try: run,
          catch: (cause) => fail(cause instanceof Error ? cause.message : String(cause)),
        });
      let loginUrl: string | null = null;
      switch (input.action) {
        case "status":
          break;
        case "login":
          loginUrl = yield* attempt(() => controller.startLogin());
          break;
        case "logout":
          yield* attempt(() => controller.logout());
          break;
        case "startWorker": {
          const worker = yield* needWorker();
          yield* attempt(() => controller.startWorker(worker));
          break;
        }
        case "stopWorker":
          yield* attempt(() => controller.stopWorker());
          break;
        case "installLogonTask": {
          const worker = yield* needWorker();
          yield* attempt(() => controller.installLogonTask(input.instanceId, worker));
          break;
        }
        case "uninstallLogonTask":
          yield* attempt(() => controller.uninstallLogonTask(input.instanceId));
          break;
      }
      const state = yield* attempt(() => controller.status());
      const logonTask = yield* attempt(() => controller.logonTaskInstalled(input.instanceId));
      return {
        instanceId: input.instanceId,
        homePath: state.homeDir,
        cliEmail: state.cliEmail,
        check: state.check,
        problem: state.problem,
        loginPending: state.loginPending,
        standardLogin: state.standardLogin,
        loginUrl,
        worker: state.worker,
        logonTask,
        logonTaskName: logonTaskName(input.instanceId),
      } satisfies CursorMachineState;
    });

  return {
    list,
    launch,
    followUp,
    stop,
    follow,
    machine,
  };
};

export type CursorAgents = ReturnType<typeof make>;
