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
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as NodePath from "node:path";

import * as ServerConfig from "../config.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as CursorAgentIndex from "./CursorAgentIndex.ts";
import { registerCursorAgentsRefresh } from "./CursorAgentsRefresh.ts";

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
  /**
   * Re-read CLI login and worker state on the scheduler tick. Only the
   * server-wide instance does this; connections read what it cached.
   */
  readonly backgroundMachineRefresh?: boolean;
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

/** CLI login and worker state is re-read in the background at most this often. */
const MACHINE_REFRESH_MS = 5 * 60_000;
const LOCAL_REFRESH_MS = 20_000;

/**
 * The in-memory Cursor state of the whole server process, one per state
 * folder: `make` runs once per WebSocket connection (and once at startup),
 * but all of them read and fill the same snapshots, with at most one sync per
 * account. The scheduler fills it; requests only read it.
 */
interface SharedCursorState {
  readonly index: CursorAgentIndex.CursorAgentIndex;
  localCwds: ReadonlyArray<string>;
  localCache: ReadonlyArray<CursorAgentDirectory.CursorDirectoryEntry>;
  lastLocalAt: number;
  readonly machineStates: Map<string, CursorMachineState>;
  /** Each account's API key as the last tick read it, so listing loads no credentials. */
  readonly apiKeys: Map<string, string>;
  machinesAt: number;
  machinesInFlight: Promise<void> | undefined;
}

const sharedStateFor = (index: CursorAgentIndex.CursorAgentIndex): SharedCursorState => ({
  index,
  localCwds: [],
  localCache: [],
  lastLocalAt: 0,
  machineStates: new Map(),
  apiKeys: new Map(),
  machinesAt: 0,
  machinesInFlight: undefined,
});

const processStates = new Map<string, SharedCursorState>();

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
  const shared =
    deps.stateDir === undefined
      ? sharedStateFor(new CursorAgentIndex.CursorAgentIndex(CursorAgentIndex.memoryStorage()))
      : (processStates.get(deps.stateDir) ??
        processStates
          .set(
            deps.stateDir,
            sharedStateFor(
              new CursorAgentIndex.CursorAgentIndex(
                CursorAgentIndex.fileStorage(NodePath.join(deps.stateDir, "cursor-agent-index")),
              ),
            ),
          )
          .get(deps.stateDir)!);
  const index = shared.index;

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

  const refresh = Effect.fn("CursorAgents.refresh")(function* () {
    const instances = yield* cursorInstances;
    const ready: Array<CursorAgentDirectory.CursorDirectoryAccount> = [];
    for (const instance of instances) {
      const account = yield* accountOf(instance, {
        ...(shared.localCwds.length === 0 ? {} : { localCwds: shared.localCwds }),
      }).pipe(Effect.timeout("15 seconds"), Effect.result);
      if (account._tag === "Success") {
        ready.push(account.success);
        shared.apiKeys.set(instance.instanceId, account.success.apiKey);
      } else shared.apiKeys.delete(instance.instanceId);
    }
    for (const account of ready) {
      yield* Effect.promise(() => index.kick(account.accountId, syncFor(account)));
    }
    const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
    // CLI login and worker state spawn `cursor-agent status` per account, so
    // they are read off the tick, every few minutes, and the page reads memory.
    const machinesMissing = instances.some(
      (instance) => !shared.machineStates.has(instance.instanceId),
    );
    if (
      deps.backgroundMachineRefresh === true &&
      shared.machinesInFlight === undefined &&
      (machinesMissing || now - shared.machinesAt >= MACHINE_REFRESH_MS)
    ) {
      shared.machinesAt = now;
      const platform = yield* HostProcess.Platform;
      shared.machinesInFlight = Effect.runPromise(
        refreshMachines(instances).pipe(Effect.provideService(HostProcess.Platform, platform)),
      ).finally(() => {
        shared.machinesInFlight = undefined;
      });
    }
    const localOwner = ready[0];
    if (
      localOwner !== undefined &&
      shared.localCwds.length > 0 &&
      now - shared.lastLocalAt >= LOCAL_REFRESH_MS
    ) {
      shared.lastLocalAt = now;
      shared.localCache = yield* deps.directory.listLocal(localOwner).pipe(
        Effect.timeout("30 seconds"),
        Effect.orElseSucceed(() => []),
      );
    }
  });

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
        const extra = {
          ...(input.localCwds === undefined ? {} : { localCwds: input.localCwds }),
          ...(input.ownMachineNames === undefined
            ? {}
            : { ownMachineNames: input.ownMachineNames }),
        };
        const cachedKey = shared.apiKeys.get(instance.instanceId);
        const account = yield* (
          cachedKey === undefined
            ? accountOf(instance, extra)
            : Effect.succeed<CursorAgentDirectory.CursorDirectoryAccount>({
                accountId: instance.instanceId,
                label: instanceLabel(instance),
                apiKey: cachedKey,
                ...extra,
              })
        ).pipe(Effect.timeout("15 seconds"), Effect.result);
        if (account._tag === "Success") ready.push(account.success);
        else
          failures.push({
            instanceId: instance.instanceId,
            message: describeCause(account.failure),
          });
      }
      // The page only reads the cache. The scheduler fills it.
      if (input.localCwds !== undefined) shared.localCwds = input.localCwds;
      const ownMachineNames = input.ownMachineNames ?? [];
      const perAccount = yield* Effect.forEach(
        ready,
        (account) =>
          Effect.promise(() => index.peek(account.accountId)).pipe(
            Effect.map((state) => ({ account, state })),
          ),
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
      const localEntries = shared.localCache;
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
      for (const { account, state } of perAccount) {
        emails.set(account.accountId, state.snapshot?.email ?? null);
      }
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

  /** The SDK login's email, from the agent index when it has one (no network call). */
  const sdkEmailOf = (instanceId: ProviderInstanceId) =>
    Effect.promise(() => index.peek(instanceId)).pipe(
      Effect.flatMap((state) =>
        state.snapshot?.email
          ? Effect.succeed<string | undefined>(state.snapshot.email)
          : accountFor("machine", instanceId).pipe(
              Effect.flatMap((account) => deps.directory.accountEmail(account)),
            ),
      ),
      Effect.orElseSucceed((): string | undefined => undefined),
    );

  const controllerFor = (instance: ProviderInstance, sdkEmail: string | undefined) =>
    Effect.gen(function* () {
      const homePath = instance.homePath ?? "";
      const key = `${instance.instanceId}\u0000${homePath}`;
      let entry = machines.get(key);
      if (entry === undefined) {
        const holder: { machine?: CursorMachine; sdkEmail: string | undefined } = { sdkEmail };
        const created = (deps.makeMachine ?? makeCursorMachine)(
          { homePath },
          {
            platform: yield* HostProcess.Platform,
            environment: process.env,
            home: NodeOS.homedir(),
            // Side by side in T3's state folder, one per instance, apart from the login.
            workerRoot: cursorWorkerRoot(
              deps.stateDir ?? NodePath.join(NodeOS.homedir(), ".t3", "userdata"),
              instance.instanceId,
            ),
            sdkEmail: async () => holder.sdkEmail,
          },
        );
        entry = Object.assign(holder, { machine: created });
        machines.set(key, entry);
      }
      entry.sdkEmail = sdkEmail;
      return entry.machine;
    });

  const failMachine = (detail: string) => new CursorAgentsError({ operation: "machine", detail });
  const attempt = <A>(run: () => Promise<A>) =>
    Effect.tryPromise({
      try: run,
      catch: (cause) => failMachine(cause instanceof Error ? cause.message : String(cause)),
    });

  /** Reads CLI login, worker and logon task (spawns processes) and caches the result. */
  const readMachineState = (
    instance: ProviderInstance,
    controller: CursorMachine,
    loginUrl: string | null,
  ) =>
    Effect.gen(function* () {
      const state = yield* attempt(() => controller.status());
      const logonTask = yield* attempt(() => controller.logonTaskInstalled(instance.instanceId));
      const result = {
        instanceId: instance.instanceId,
        homePath: state.homeDir,
        cliEmail: state.cliEmail,
        check: state.check,
        problem: state.problem,
        loginPending: state.loginPending,
        standardLogin: state.standardLogin,
        loginUrl,
        worker: state.worker,
        logonTask,
        logonTaskName: logonTaskName(instance.instanceId),
      } satisfies CursorMachineState;
      // A login URL belongs to the request that started the login, not to the cache.
      shared.machineStates.set(instance.instanceId, { ...result, loginUrl: null });
      return result;
    });

  function refreshMachines(instances: ReadonlyArray<ProviderInstance>) {
    return Effect.forEach(
      instances,
      (instance) =>
        sdkEmailOf(instance.instanceId).pipe(
          Effect.flatMap((sdkEmail) => controllerFor(instance, sdkEmail)),
          Effect.flatMap((controller) => readMachineState(instance, controller, null)),
          Effect.ignore,
        ),
      { discard: true },
    );
  }

  const machine = (input: CursorMachineInput) =>
    Effect.gen(function* () {
      const instances = yield* cursorInstances;
      const instance = instances.find((candidate) => candidate.instanceId === input.instanceId);
      if (instance === undefined) {
        return yield* failMachine(`Cursor account ${input.instanceId} is not enabled.`);
      }
      if (input.action === "status") {
        // Served from memory; the scheduler keeps it fresh.
        const cached = shared.machineStates.get(input.instanceId);
        if (cached !== undefined) return cached;
        const inFlight = shared.machinesInFlight;
        if (inFlight !== undefined) {
          yield* Effect.promise(() => inFlight);
          const filled = shared.machineStates.get(input.instanceId);
          if (filled !== undefined) return filled;
        }
      }
      // Without an SDK login the email stays unknown: CLI sign-in and status
      // still work, while the guard keeps workers and logon tasks blocked.
      const sdkEmail = yield* sdkEmailOf(input.instanceId);
      const controller = yield* controllerFor(instance, sdkEmail);
      const needWorker = () =>
        input.worker === undefined
          ? Effect.fail(failMachine("Worker name, folder and labels are required."))
          : Effect.succeed(input.worker);
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
      return yield* readMachineState(instance, controller, loginUrl);
    });

  return {
    list,
    launch,
    followUp,
    stop,
    follow,
    machine,
    refresh: refresh(),
    settle: Effect.promise(() => index.settle()),
  };
};

export type CursorAgents = ReturnType<typeof make>;

/**
 * Builds the shared Cursor state at server start and hands its refresh to the
 * scheduler tick, so the first page load already finds agents, accounts and
 * machine state in memory instead of waiting for a connection to register it.
 */
export const layerWarmup = Layer.effectDiscard(
  Effect.gen(function* () {
    const providerInstances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
    const agents = make({
      listInstances: providerInstances.listInstances,
      directory: yield* CursorAgentDirectory.makeLive,
      stateDir: (yield* ServerConfig.ServerConfig).stateDir,
      backgroundMachineRefresh: true,
    });
    registerCursorAgentsRefresh(agents.refresh);
  }),
);
