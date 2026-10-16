/**
 * Cursor agents across runtimes (local SDK, Cursor Cloud, Self-Hosted pools
 * and machines) and Cursor accounts, as one list for the Cursor agents page.
 *
 * @module contracts/cursorAgents
 */
import * as Schema from "effect/Schema";

import { ProviderInstanceId } from "./providerInstance.ts";

export const CursorAgentRuntime = Schema.Literals([
  "local",
  "local-worker",
  "cloud",
  "self-hosted-pool",
  "self-hosted-machine",
]);
export type CursorAgentRuntime = typeof CursorAgentRuntime.Type;

export const CursorAgentStatus = Schema.Literals(["running", "finished", "error", "unknown"]);
export type CursorAgentStatus = typeof CursorAgentStatus.Type;

export const CursorAgentAccount = Schema.Struct({
  instanceId: ProviderInstanceId,
  label: Schema.String,
  /** Email that owns this instance's login; null when unknown or signed out. */
  email: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /** Set when another enabled instance is signed in to the same account. */
  sharedWith: Schema.optionalKey(Schema.Array(ProviderInstanceId)),
  /** When this account's agent index was last synced (ms); null before the first sync. */
  syncedAt: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  /** True while a sync of this account runs in the background. */
  syncing: Schema.optionalKey(Schema.Boolean),
});
export type CursorAgentAccount = typeof CursorAgentAccount.Type;

export const CursorAgentEntry = Schema.Struct({
  agentId: Schema.String,
  instanceId: ProviderInstanceId,
  /**
   * Local agents: Cursor's local store is shared by every login on this
   * computer and records no account, so they belong to all accounts.
   * `instanceId` only names the login used to open them.
   */
  sharedAcrossAccounts: Schema.optionalKey(Schema.Boolean),
  runtime: CursorAgentRuntime,
  environmentName: Schema.NullOr(Schema.String),
  name: Schema.String,
  summary: Schema.String,
  status: CursorAgentStatus,
  repos: Schema.Array(Schema.String),
  cwd: Schema.NullOr(Schema.String),
  createdByT3: Schema.Boolean,
  archived: Schema.Boolean,
  updatedAt: Schema.Finite,
});
export type CursorAgentEntry = typeof CursorAgentEntry.Type;

export const CursorAgentsListInput = Schema.Struct({
  /** Workspaces whose local Cursor agent stores are included. */
  localCwds: Schema.optionalKey(Schema.Array(Schema.String)),
  /** My Machines worker names running on this computer (shown as Local). */
  ownMachineNames: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type CursorAgentsListInput = typeof CursorAgentsListInput.Type;

export const CursorAgentsListResult = Schema.Struct({
  accounts: Schema.Array(CursorAgentAccount),
  entries: Schema.Array(CursorAgentEntry),
  /** Accounts whose list failed; the rest of the list is still valid. */
  failures: Schema.Array(Schema.Struct({ instanceId: ProviderInstanceId, message: Schema.String })),
});
export type CursorAgentsListResult = typeof CursorAgentsListResult.Type;

export const CursorAgentsLaunchInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  name: Schema.String,
  prompt: Schema.String,
  model: Schema.optionalKey(Schema.String),
  runtime: CursorAgentRuntime,
  /** Required for local agents. */
  cwd: Schema.optionalKey(Schema.String),
  /** Required for cloud and self-hosted agents. */
  repoUrl: Schema.optionalKey(Schema.String),
  startingRef: Schema.optionalKey(Schema.String),
  /** Pool or machine name for self-hosted runtimes. */
  environmentName: Schema.optionalKey(Schema.String),
  autoCreatePR: Schema.optionalKey(Schema.Boolean),
});
export type CursorAgentsLaunchInput = typeof CursorAgentsLaunchInput.Type;

export const CursorAgentsRunResult = Schema.Struct({
  agentId: Schema.String,
  runId: Schema.NullOr(Schema.String),
});
export type CursorAgentsRunResult = typeof CursorAgentsRunResult.Type;

export const CursorAgentTarget = Schema.Struct({
  instanceId: ProviderInstanceId,
  agentId: Schema.String,
  cwd: Schema.optionalKey(Schema.String),
});
export type CursorAgentTarget = typeof CursorAgentTarget.Type;

export const CursorAgentsFollowUpInput = Schema.Struct({
  ...CursorAgentTarget.fields,
  prompt: Schema.String,
});
export type CursorAgentsFollowUpInput = typeof CursorAgentsFollowUpInput.Type;

/** One line of a followed run, already flattened for display. */
export const CursorAgentStreamEvent = Schema.Struct({
  kind: Schema.Literals(["assistant", "thinking", "tool", "status", "user", "other"]),
  text: Schema.String,
});
export type CursorAgentStreamEvent = typeof CursorAgentStreamEvent.Type;

/** A worker agent's hook request waiting for the user on the agents page. */
export const CursorWorkerApproval = Schema.Struct({
  id: Schema.String,
  agentId: Schema.NullOr(Schema.String),
  kind: Schema.Literals(["command", "file-read", "file-change", "permission"]),
  title: Schema.String,
  detail: Schema.String,
  workspaceRoots: Schema.Array(Schema.String),
  createdAt: Schema.String,
});
export type CursorWorkerApproval = typeof CursorWorkerApproval.Type;

export const CursorAgentsApprovalsResult = Schema.Struct({
  approvals: Schema.Array(CursorWorkerApproval),
});
export type CursorAgentsApprovalsResult = typeof CursorAgentsApprovalsResult.Type;

export const CursorAgentsRespondApprovalInput = Schema.Struct({
  id: Schema.String,
  decision: Schema.Literals(["allow", "deny"]),
});
export type CursorAgentsRespondApprovalInput = typeof CursorAgentsRespondApprovalInput.Type;

export const CursorAgentsRespondApprovalResult = Schema.Struct({ found: Schema.Boolean });
export type CursorAgentsRespondApprovalResult = typeof CursorAgentsRespondApprovalResult.Type;

export const CursorAgentsHookSetupInput = Schema.Struct({
  /** Start the bridge and write the worker env file when not running yet. */
  start: Schema.optional(Schema.Boolean),
});
export type CursorAgentsHookSetupInput = typeof CursorAgentsHookSetupInput.Type;

/** How a worker reaches T3's hook bridge. The token itself never leaves the server. */
export const CursorAgentsHookSetup = Schema.Struct({
  running: Schema.Boolean,
  url: Schema.NullOr(Schema.String),
  /** Owner-only file with the URL and token, sourced before `agent worker start`. */
  envFile: Schema.NullOr(Schema.String),
  urlEnv: Schema.String,
  tokenEnv: Schema.String,
});
export type CursorAgentsHookSetup = typeof CursorAgentsHookSetup.Type;

export const CursorAgentsProjectHooksInput = Schema.Struct({
  repoRoot: Schema.String,
  /** Install (`true`) or remove (`false`); omit to read the state. */
  enabled: Schema.optional(Schema.Boolean),
});
export type CursorAgentsProjectHooksInput = typeof CursorAgentsProjectHooksInput.Type;

export const CursorAgentsProjectHooksResult = Schema.Struct({
  repoRoot: Schema.String,
  enabled: Schema.Boolean,
  hooksFile: Schema.String,
});
export type CursorAgentsProjectHooksResult = typeof CursorAgentsProjectHooksResult.Type;

export const CursorMachineAction = Schema.Literals([
  "status",
  "login",
  "logout",
  "startWorker",
  "stopWorker",
  "installLogonTask",
  "uninstallLogonTask",
]);
export type CursorMachineAction = typeof CursorMachineAction.Type;

export const CursorWorkerSpec = Schema.Struct({
  name: Schema.String,
  workerDir: Schema.String,
  labels: Schema.Array(Schema.String),
});
export type CursorWorkerSpec = typeof CursorWorkerSpec.Type;

/** CLI profile and worker controls of one Cursor instance on the server's machine. */
export const CursorMachineInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  action: CursorMachineAction,
  worker: Schema.optional(CursorWorkerSpec),
});
export type CursorMachineInput = typeof CursorMachineInput.Type;

export const CursorMachineState = Schema.Struct({
  instanceId: ProviderInstanceId,
  /** The instance's resolved Cursor home (its homePath, else the standard login folder). */
  homePath: Schema.String,
  cliEmail: Schema.NullOr(Schema.String),
  check: Schema.Literals(["match", "cliSignedOut", "sdkEmailUnknown", "mismatch"]),
  problem: Schema.NullOr(Schema.String),
  loginPending: Schema.Boolean,
  /** True when the instance uses the machine's standard Cursor login (empty homePath). */
  standardLogin: Schema.Boolean,
  /** Sign-in link of a login started by this request. */
  loginUrl: Schema.NullOr(Schema.String),
  worker: Schema.Struct({
    running: Schema.Boolean,
    pid: Schema.NullOr(Schema.Number),
    startedAt: Schema.NullOr(Schema.String),
    lastExit: Schema.NullOr(Schema.String),
  }),
  logonTask: Schema.Boolean,
  logonTaskName: Schema.NullOr(Schema.String),
});
export type CursorMachineState = typeof CursorMachineState.Type;

export class CursorAgentsError extends Schema.TaggedError<CursorAgentsError>()(
  "CursorAgentsError",
  {
    operation: Schema.Literals([
      "list",
      "launch",
      "followUp",
      "stop",
      "follow",
      "approvals",
      "setup",
      "projectHooks",
      "machine",
    ]),
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Cursor agents ${this.operation} failed: ${this.detail}`;
  }
}
