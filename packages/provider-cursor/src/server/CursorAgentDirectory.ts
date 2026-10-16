/**
 * One list for every Cursor agent a user owns, across the runtimes Cursor
 * offers: local SDK/CLI agents, Cursor-hosted Cloud Agents, and Cloud Agents
 * whose tools run on Self-Hosted Machines (a named team pool or one personal
 * machine). Each Cursor account (API key) is queried separately so several
 * subscriptions and teams show side by side and are never mixed up.
 *
 * Agents launched here are labeled so they are recognizable inside Cursor as
 * well: the name carries a runtime prefix ("[T3 · Cloud]") and cloud agents
 * carry `metadata` tags (`createdBy`, `t3Runtime`, `t3Account`), which Cursor
 * persists and returns on `Agent.list` / `Agent.get`.
 *
 * Cursor limits: local agents live in the SDK's on-disk store and never sync
 * to cursor.com/agents; the SDK cannot list workers or pools themselves, only
 * agents and the `env` they were routed to.
 *
 * @module provider-cursor/server/CursorAgentDirectory
 */
import type {
  AgentOptions,
  ListAgentsOptions,
  ListResult,
  ListRunsOptions,
  Run,
  SDKAgent,
  SDKAgentInfo,
  SDKMessage,
} from "@cursor/sdk";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { Agent, Cursor } from "./sdk.ts";
import { isCloudAgentId } from "./runsOn.ts";

const RUN_LIST_PAGE_SIZE = 100;
const RUN_LIST_MAX_PAGES = 20;
const runCreatedAt = (run: unknown): number => {
  const value = (run as { createdAt?: unknown }).createdAt;
  return typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) || 0 : 0;
};

/**
 * `local-worker` is a Cloud Agent routed to a My Machines worker the user runs
 * on this computer (`agent worker start --name <machine>`). Tools run locally
 * like a local SDK agent, but Cursor owns the agent, so it shows up in
 * Cursor's own agent list. It is the documented way to make local work
 * visible in Cursor; plain local SDK agents never sync there.
 */
export type CursorAgentRuntimeKind =
  | "local"
  | "local-worker"
  | "cloud"
  | "self-hosted-pool"
  | "self-hosted-machine";

export const CURSOR_AGENT_RUNTIME_LABEL: Record<CursorAgentRuntimeKind, string> = {
  local: "Local",
  "local-worker": "Local",
  cloud: "Cloud",
  "self-hosted-pool": "Self-hosted",
  "self-hosted-machine": "Self-hosted",
};

export const T3_AGENT_METADATA_SOURCE = "t3code";

/**
 * One Cursor login. The key is required: falling back to a machine-wide
 * credential could silently act as a different account.
 */
export interface CursorDirectoryAccount {
  readonly accountId: string;
  readonly label: string;
  readonly apiKey: string;
  /** Workspaces whose local agent stores are scanned for this account. */
  readonly localCwds?: ReadonlyArray<string>;
  /** My Machines worker names that run on this computer. */
  readonly ownMachineNames?: ReadonlyArray<string>;
}

export interface CursorDirectoryEntry {
  readonly agentId: string;
  readonly accountId: string;
  readonly runtime: CursorAgentRuntimeKind;
  readonly runtimeLabel: string;
  /** Pool or machine name for self-hosted agents, environment name for cloud. */
  readonly environmentName: string | undefined;
  readonly name: string;
  readonly summary: string;
  readonly status: "running" | "finished" | "error" | "unknown";
  readonly repos: ReadonlyArray<string>;
  readonly cwd: string | undefined;
  readonly createdByT3: boolean;
  readonly archived: boolean;
  readonly updatedAt: number;
}

export interface CursorDirectoryLaunchInput {
  readonly account: CursorDirectoryAccount;
  readonly prompt: string;
  readonly name: string;
  readonly model?: AgentOptions["model"];
  readonly target:
    | { readonly runtime: "local"; readonly cwd: string }
    | {
        readonly runtime: "cloud" | "self-hosted-pool" | "self-hosted-machine" | "local-worker";
        readonly repoUrl: string;
        readonly startingRef?: string;
        /** Pool name (default pool when omitted) or machine name. */
        readonly environmentName?: string;
        readonly autoCreatePR?: boolean;
      };
}

/** The `Agent` statics this module needs; injectable for tests. */
export interface CursorDirectorySdk {
  readonly list: (options: ListAgentsOptions) => Promise<ListResult<SDKAgentInfo>>;
  readonly create: (options: AgentOptions) => Promise<SDKAgent>;
  readonly resume: (agentId: string, options?: Partial<AgentOptions>) => Promise<SDKAgent>;
  readonly listRuns: (agentId: string, options?: ListRunsOptions) => Promise<ListResult<Run>>;
  readonly cancelRun: (
    runId: string,
    options?:
      | { readonly runtime?: "local"; readonly cwd?: string }
      | { readonly runtime: "cloud"; readonly agentId: string; readonly apiKey?: string },
  ) => Promise<void>;
  /**
   * Cloud agent statuses by agent id. `Agent.list` omits status, so the live
   * directory reads it from the Cloud Agents REST API (`GET /v0/agents`).
   */
  readonly cloudStatuses?: (
    apiKey: string | undefined,
  ) => Promise<ReadonlyMap<string, CursorDirectoryEntry["status"]>>;
  /** One cloud agent's status (`GET /v0/agents/{id}`), for delta syncs. */
  readonly cloudStatus?: (
    apiKey: string,
    agentId: string,
  ) => Promise<CursorDirectoryEntry["status"]>;
  /** Email that owns the key (`Cursor.me`), used to show and verify accounts. */
  readonly accountEmail?: (apiKey: string) => Promise<string | undefined>;
}

export class CursorAgentDirectoryError extends Schema.TaggedError<CursorAgentDirectoryError>()(
  "CursorAgentDirectoryError",
  {
    operation: Schema.String,
    accountId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Cursor agent directory ${this.operation} failed for account ${this.accountId}.`;
  }
}

export function runtimeOfAgent(
  info: SDKAgentInfo,
  ownMachineNames: ReadonlyArray<string> = [],
): CursorAgentRuntimeKind {
  if (info.runtime === "cloud" || (info.runtime === undefined && isCloudAgentId(info.agentId))) {
    const env = info.runtime === "cloud" ? info.env : undefined;
    if (env?.type === "pool") return "self-hosted-pool";
    if (env?.type === "machine") {
      return env.name !== undefined && ownMachineNames.includes(env.name)
        ? "local-worker"
        : "self-hosted-machine";
    }
    return "cloud";
  }
  return "local";
}

/** Prefix that makes the runtime readable in Cursor's own agent list. */
export function labeledAgentName(runtime: CursorAgentRuntimeKind, name: string): string {
  const prefix = `[T3 · ${CURSOR_AGENT_RUNTIME_LABEL[runtime]}]`;
  const trimmed = name.trim();
  return trimmed.startsWith("[T3 ·") ? trimmed : `${prefix} ${trimmed}`.trim();
}

export function directoryEntry(
  account: CursorDirectoryAccount,
  info: SDKAgentInfo,
): CursorDirectoryEntry {
  const runtime = runtimeOfAgent(info, account.ownMachineNames);
  const cloud = info.runtime === "cloud" ? info : undefined;
  const metadata = cloud?.metadata ?? {};
  return {
    agentId: info.agentId,
    accountId: account.accountId,
    runtime,
    runtimeLabel: CURSOR_AGENT_RUNTIME_LABEL[runtime],
    environmentName: cloud?.env?.name,
    name: info.name,
    summary: info.summary,
    status: info.status ?? "unknown",
    repos: cloud?.repos ?? [],
    cwd: info.runtime === "local" ? info.cwd : undefined,
    createdByT3: metadata.createdBy === T3_AGENT_METADATA_SOURCE || info.name.startsWith("[T3 ·"),
    archived: info.archived === true,
    updatedAt: info.lastModified,
  };
}

const MAX_PAGES = 20;
/** Cloud pages are newest change first; 100 per page instead of the default 20. */
const CLOUD_PAGE_SIZE = 100;
const CLOUD_MAX_PAGES = 100;

export const make = (sdk: CursorDirectorySdk) => {
  const attempt = <A>(operation: string, accountId: string, run: () => Promise<A>) =>
    Effect.tryPromise({
      try: run,
      catch: (cause) => new CursorAgentDirectoryError({ operation, accountId, cause }),
    });

  const listAll = (account: CursorDirectoryAccount, options: ListAgentsOptions) =>
    Effect.gen(function* () {
      const items: Array<SDKAgentInfo> = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const result = yield* attempt(
          `list.${options.runtime ?? "default"}`,
          account.accountId,
          () => sdk.list({ ...options, ...(cursor === undefined ? {} : { cursor }) }),
        );
        items.push(...result.items);
        cursor = result.nextCursor;
        if (cursor === undefined) break;
      }
      return items;
    });

  const cloudOptions = (account: CursorDirectoryAccount) => ({ apiKey: account.apiKey });

  /**
   * Lists every agent of every account. One failing account (expired key,
   * plan without Cloud Agents) is reported in `failures` and does not hide
   * the others.
   */
  /** The key owner's email; undefined when Cursor does not report one. */
  const accountEmail = (account: CursorDirectoryAccount) =>
    sdk.accountEmail === undefined
      ? Effect.succeed(undefined)
      : attempt("account", account.accountId, () => sdk.accountEmail!(account.apiKey));

  const listAgents = (accounts: ReadonlyArray<CursorDirectoryAccount>) =>
    Effect.forEach(
      accounts,
      (account) =>
        Effect.gen(function* () {
          const sources = [
            listAll(account, { runtime: "cloud", ...cloudOptions(account) }),
            ...(account.localCwds ?? []).map((cwd) =>
              listAll(account, { runtime: "local", cwd }).pipe(
                Effect.map((items) =>
                  items.map((item) =>
                    item.runtime === "local" && item.cwd === undefined ? { ...item, cwd } : item,
                  ),
                ),
              ),
            ),
          ];
          // Lists and the status lookup run side by side; run one after the
          // other they added up past the page's time limit on large accounts.
          const [results, statuses] = yield* Effect.all(
            [
              Effect.forEach(sources, (source) => Effect.result(source), {
                concurrency: "unbounded",
              }),
              sdk.cloudStatuses === undefined
                ? Effect.succeed(undefined)
                : Effect.result(
                    attempt("list.status", account.accountId, () =>
                      sdk.cloudStatuses!(account.apiKey),
                    ),
                  ),
            ],
            { concurrency: "unbounded" },
          );
          const statusOf = (info: SDKAgentInfo) =>
            statuses?._tag === "Success" ? statuses.success.get(info.agentId) : undefined;
          const entries: Array<CursorDirectoryEntry> = [];
          const failures: Array<CursorAgentDirectoryError> = [];
          if (statuses?._tag === "Failure") failures.push(statuses.failure);
          for (const result of results) {
            if (result._tag === "Success") {
              entries.push(
                ...result.success.map((info) => {
                  const entry = directoryEntry(account, info);
                  const status = statusOf(info);
                  return status === undefined || entry.status !== "unknown"
                    ? entry
                    : { ...entry, status };
                }),
              );
            } else {
              failures.push(result.failure);
            }
          }
          return { entries, failures };
        }),
      { concurrency: 4 },
    ).pipe(
      Effect.map((perAccount) => {
        const seen = new Set<string>();
        const entries = perAccount
          .flatMap((account) => account.entries)
          .filter((entry) => {
            const key = `${entry.accountId}:${entry.agentId}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          })
          .toSorted((a, b) => b.updatedAt - a.updatedAt);
        return { entries, failures: perAccount.flatMap((account) => account.failures) };
      }),
    );

  /** Builds the SDK options for a launch; exported through `launch` for tests. */
  const launchOptions = (input: CursorDirectoryLaunchInput): AgentOptions => {
    const name = labeledAgentName(input.target.runtime, input.name);
    const base = {
      name,
      ...(input.model === undefined ? {} : { model: input.model }),
      apiKey: input.account.apiKey,
    };
    if (input.target.runtime === "local") {
      // Local SDK runs reject a missing model; fall back to Cursor's "Auto".
      return {
        ...base,
        ...(input.model === undefined ? { model: { id: "default" } } : {}),
        local: { cwd: input.target.cwd },
      } as AgentOptions;
    }
    const envType =
      input.target.runtime === "self-hosted-pool"
        ? "pool"
        : input.target.runtime === "self-hosted-machine" || input.target.runtime === "local-worker"
          ? "machine"
          : "cloud";
    return {
      ...base,
      cloud: {
        env: {
          type: envType,
          ...(input.target.environmentName === undefined
            ? {}
            : { name: input.target.environmentName }),
        },
        repos: [
          {
            url: input.target.repoUrl,
            ...(input.target.startingRef === undefined
              ? {}
              : { startingRef: input.target.startingRef }),
          },
        ],
        ...(input.target.autoCreatePR === undefined
          ? {}
          : { autoCreatePR: input.target.autoCreatePR }),
        metadata: {
          createdBy: T3_AGENT_METADATA_SOURCE,
          t3Runtime: input.target.runtime,
          t3Account: input.account.accountId,
        },
      },
    } as AgentOptions;
  };

  const launch = (input: CursorDirectoryLaunchInput) =>
    attempt("launch", input.account.accountId, async () => {
      const agent = await sdk.create(launchOptions(input));
      const run = await agent.send(input.prompt);
      return { agentId: agent.agentId, runId: run.id };
    });

  const followUp = (input: {
    readonly account: CursorDirectoryAccount;
    readonly agentId: string;
    readonly prompt: string;
    readonly cwd?: string;
  }) =>
    attempt("followUp", input.account.accountId, async () => {
      const agent = await sdk.resume(input.agentId, {
        apiKey: input.account.apiKey,
        ...(input.cwd === undefined ? {} : { model: { id: "default" }, local: { cwd: input.cwd } }),
      } as Partial<AgentOptions>);
      const run = await agent.send(input.prompt);
      return { agentId: agent.agentId, runId: run.id };
    });

  const runOptionsFor = (
    account: CursorDirectoryAccount,
    agentId: string,
    cwd: string | undefined,
  ) =>
    isCloudAgentId(agentId)
      ? ({ runtime: "cloud", ...cloudOptions(account) } as const)
      : ({ runtime: "local", ...(cwd === undefined ? {} : { cwd }) } as const);

  /**
   * All runs of an agent, newest first. The SDK's order differs by runtime: local
   * `listRuns` returns oldest first (proven on SCH99: limit 1 gave the agent's first
   * run), so `limit: 1` is not "latest". Pages through and sorts by `createdAt`.
   */
  const runsNewestFirst = async (
    account: CursorDirectoryAccount,
    agentId: string,
    cwd: string | undefined,
  ) => {
    const runs: Array<Awaited<ReturnType<typeof sdk.listRuns>>["items"][number]> = [];
    let cursor: string | undefined;
    for (let page = 0; page < RUN_LIST_MAX_PAGES; page += 1) {
      const result = await sdk.listRuns(agentId, {
        ...runOptionsFor(account, agentId, cwd),
        limit: RUN_LIST_PAGE_SIZE,
        ...(cursor === undefined ? {} : { cursor }),
      } as ListRunsOptions);
      runs.push(...result.items);
      cursor = result.nextCursor;
      if (cursor === undefined) break;
    }
    return runs.toSorted((a, b) => runCreatedAt(b) - runCreatedAt(a));
  };

  /** Cancels the agent's running run, if any. Returns the cancelled run id. */
  const stop = (input: {
    readonly account: CursorDirectoryAccount;
    readonly agentId: string;
    readonly cwd?: string;
  }) =>
    attempt("stop", input.account.accountId, async () => {
      const runs = await runsNewestFirst(input.account, input.agentId, input.cwd);
      const active = runs.find((run) => String(run.status).toLowerCase() === "running");
      if (active === undefined) return undefined;
      await sdk.cancelRun(
        active.id,
        isCloudAgentId(input.agentId)
          ? { runtime: "cloud", agentId: input.agentId, ...cloudOptions(input.account) }
          : { runtime: "local", ...(input.cwd === undefined ? {} : { cwd: input.cwd }) },
      );
      return active.id;
    });

  /** Streams the latest run's messages (live while it runs, replay after). */
  const follow = (input: {
    readonly account: CursorDirectoryAccount;
    readonly agentId: string;
    readonly cwd?: string;
  }): Stream.Stream<SDKMessage, CursorAgentDirectoryError> =>
    Stream.unwrap(
      attempt("follow", input.account.accountId, () =>
        runsNewestFirst(input.account, input.agentId, input.cwd),
      ).pipe(
        Effect.map((runs) => {
          const latest = runs[0];
          if (latest === undefined) return Stream.empty;
          return Stream.fromAsyncIterable(
            latest.stream(),
            (cause) =>
              new CursorAgentDirectoryError({
                operation: "follow.stream",
                accountId: input.account.accountId,
                cause,
              }),
          );
        }),
      ),
    );

  /**
   * Cloud and self-hosted agents, newest change first. With `since`, stops
   * after the first page that reaches agents unchanged since then (a delta).
   */
  const listCloud = (account: CursorDirectoryAccount, since: number | undefined) =>
    Effect.gen(function* () {
      const items: Array<SDKAgentInfo> = [];
      let cursor: string | undefined;
      let complete = false;
      for (let page = 0; page < CLOUD_MAX_PAGES; page += 1) {
        const result = yield* attempt("list.cloud", account.accountId, () =>
          sdk.list({
            runtime: "cloud",
            ...cloudOptions(account),
            limit: CLOUD_PAGE_SIZE,
            ...(cursor === undefined ? {} : { cursor }),
          }),
        );
        items.push(...result.items);
        cursor = result.nextCursor;
        if (cursor === undefined) {
          complete = true;
          break;
        }
        const last = result.items.at(-1);
        if (since !== undefined && (last === undefined || last.lastModified < since)) break;
      }
      return { entries: items.map((info) => directoryEntry(account, info)), complete };
    });

  /** Statuses of all cloud agents, or of the given ones only. */
  const cloudStatusesOf = (
    account: CursorDirectoryAccount,
    agentIds: ReadonlyArray<string> | "all",
  ): Effect.Effect<
    ReadonlyMap<string, CursorDirectoryEntry["status"]>,
    CursorAgentDirectoryError
  > =>
    agentIds === "all"
      ? sdk.cloudStatuses === undefined
        ? Effect.succeed(new Map())
        : attempt("list.status", account.accountId, () => sdk.cloudStatuses!(account.apiKey))
      : Effect.forEach(
          agentIds,
          (agentId) =>
            sdk.cloudStatus === undefined
              ? Effect.succeed(undefined)
              : attempt("status", account.accountId, () =>
                  sdk.cloudStatus!(account.apiKey, agentId),
                ).pipe(
                  Effect.map((status) => [agentId, status] as const),
                  Effect.orElseSucceed(() => undefined),
                ),
          { concurrency: 4 },
        ).pipe(
          Effect.map(
            (pairs) =>
              new Map(pairs.filter((pair): pair is NonNullable<typeof pair> => pair !== undefined)),
          ),
        );

  /** Agents in this computer's local Cursor store; the store does not record an account. */
  const listLocal = (account: CursorDirectoryAccount) =>
    Effect.forEach(
      account.localCwds ?? [],
      (cwd) =>
        listAll(account, { runtime: "local", cwd }).pipe(
          Effect.map((items) =>
            items.map((item) =>
              directoryEntry(
                account,
                item.runtime === "local" && item.cwd === undefined ? { ...item, cwd } : item,
              ),
            ),
          ),
        ),
      { concurrency: "unbounded" },
    ).pipe(Effect.map((perCwd) => perCwd.flat()));

  return {
    listAgents,
    listCloud,
    cloudStatusesOf,
    listLocal,
    accountEmail,
    launch,
    launchOptions,
    followUp,
    stop,
    follow,
  };
};

export type CursorAgentDirectory = ReturnType<typeof make>;

/** Directory bound to the installed `@cursor/sdk`. */
export const makeLive = Effect.sync(() =>
  make({
    list: (options) => Agent.list(options),
    create: (options) => Agent.create(options),
    resume: (agentId, options) => Agent.resume(agentId, options),
    listRuns: (agentId, options) => Agent.listRuns(agentId, options),
    cancelRun: (runId, options) => Agent.cancelRun(runId, options),
    cloudStatuses: fetchCloudStatuses,
    cloudStatus: fetchCloudStatus,
    accountEmail: async (apiKey) => (await Cursor.me({ apiKey })).userEmail,
  }),
);

/** Maps a Cloud Agents REST status (`RUNNING`, `FINISHED`, ...) to the directory status. */
export function directoryStatusOf(raw: unknown): CursorDirectoryEntry["status"] {
  switch (typeof raw === "string" ? raw.toUpperCase() : "") {
    case "CREATING":
    case "RUNNING":
      return "running";
    case "FINISHED":
    case "EXPIRED":
      return "finished";
    case "ERROR":
      return "error";
    default:
      return "unknown";
  }
}

const CLOUD_API = "https://api.cursor.com/v0/agents";

type StatusPage = {
  agents?: ReadonlyArray<{ id?: string; status?: string }>;
  nextCursor?: string;
};

const STATUS_PAGE_ATTEMPTS = 3;
const STATUS_PAGE_TIMEOUT_MS = 30_000;
/** How long a status scan counts as current; older ones are served while a new one runs. */
const STATUS_FRESH_MS = 30_000;

/** One status page; a slow or failed page is retried before the scan fails. */
async function fetchStatusPage<T = StatusPage>(url: URL, auth: string): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < STATUS_PAGE_ATTEMPTS; attempt += 1) {
    try {
      // @effect-diagnostics-next-line globalFetch:off -- plain REST call inside a Promise helper.
      const response = await fetch(url, {
        headers: { authorization: auth },
        signal: AbortSignal.timeout(STATUS_PAGE_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(`Cursor agents status request failed: ${response.status}`);
      }
      return (await response.json()) as T;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

/** Every page of one account's agent statuses, in order. */
async function scanCloudStatuses(
  apiKey: string,
): Promise<ReadonlyMap<string, CursorDirectoryEntry["status"]>> {
  const statuses = new Map<string, CursorDirectoryEntry["status"]>();
  const auth = `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`;
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url = new URL(CLOUD_API);
    url.searchParams.set("limit", "100");
    if (cursor !== undefined) url.searchParams.set("cursor", cursor);
    const body = await fetchStatusPage(url, auth);
    for (const agent of body.agents ?? []) {
      if (agent.id !== undefined) statuses.set(agent.id, directoryStatusOf(agent.status));
    }
    cursor = body.nextCursor;
    if (cursor === undefined || cursor === "") break;
  }
  return statuses;
}

async function fetchCloudStatus(
  apiKey: string,
  agentId: string,
): Promise<CursorDirectoryEntry["status"]> {
  const auth = `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`;
  const body = await fetchStatusPage<{ status?: string }>(
    new URL(`${CLOUD_API}/${encodeURIComponent(agentId)}`),
    auth,
  );
  return directoryStatusOf(body.status);
}

interface StatusCacheEntry {
  statuses: ReadonlyMap<string, CursorDirectoryEntry["status"]> | undefined;
  at: number;
  inFlight: Promise<ReadonlyMap<string, CursorDirectoryEntry["status"]>> | undefined;
}

/**
 * Per account (keyed in memory only), at most one status scan runs at a time
 * and every caller shares it. Every browser window, reload and refresh used
 * to start its own full scan; a dozen parallel scans slowed single pages
 * from seconds to over half a minute. A finished scan is served right away;
 * once it is older than STATUS_FRESH_MS a new one starts in the background.
 */
const statusCache = new Map<string, StatusCacheEntry>();

async function fetchCloudStatuses(
  apiKey: string | undefined,
): Promise<ReadonlyMap<string, CursorDirectoryEntry["status"]>> {
  if (apiKey === undefined || apiKey === "") return new Map();
  let entry = statusCache.get(apiKey);
  if (entry === undefined) {
    entry = { statuses: undefined, at: 0, inFlight: undefined };
    statusCache.set(apiKey, entry);
  }
  const current = entry;
  const refresh = () => {
    current.inFlight ??= scanCloudStatuses(apiKey)
      .then((statuses) => {
        current.statuses = statuses;
        // @effect-diagnostics-next-line globalDate:off -- cache age inside a Promise helper.
        current.at = Date.now();
        return statuses;
      })
      .finally(() => {
        current.inFlight = undefined;
      });
    return current.inFlight;
  };
  if (current.statuses !== undefined) {
    // @effect-diagnostics-next-line globalDate:off -- cache age inside a Promise helper.
    if (Date.now() - current.at > STATUS_FRESH_MS) void refresh().catch(() => undefined);
    return current.statuses;
  }
  return refresh();
}

/** Flattens one SDK stream message into a display line. */
export function streamLineOf(message: SDKMessage): {
  readonly kind: "assistant" | "thinking" | "tool" | "status" | "user" | "other";
  readonly text: string;
} {
  switch (message.type) {
    case "assistant":
      return {
        kind: "assistant",
        text: message.message.content
          .map((block) => (block.type === "text" ? block.text : `[${block.name}]`))
          .join(""),
      };
    case "user":
      return { kind: "user", text: message.message.content.map((block) => block.text).join("") };
    case "thinking":
      return { kind: "thinking", text: message.text };
    case "tool_call":
      return { kind: "tool", text: `${message.name} · ${message.status}` };
    case "status":
      return {
        kind: "status",
        text:
          message.message === undefined ? message.status : `${message.status}: ${message.message}`,
      };
    default:
      return { kind: "other", text: message.type };
  }
}
