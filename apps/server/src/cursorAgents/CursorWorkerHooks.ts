// @effect-diagnostics nodeBuiltinImport:off -- writes the owner-only worker env file and repo hooks.
/**
 * Worker-run approvals for the Cursor agents page: the shared hook bridge
 * with a token persisted under the T3 state directory, an owner-only env file
 * for `agent worker start`, project hook install/remove per repository, and
 * the queue of worker hook requests waiting for the user.
 *
 * @module server/cursorAgents/CursorWorkerHooks
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  CursorAgentsError,
  type CursorAgentsApprovalsResult,
  type CursorAgentsHookSetup,
  type CursorAgentsHookSetupInput,
  type CursorAgentsProjectHooksInput,
  type CursorAgentsProjectHooksResult,
  type CursorAgentsRespondApprovalInput,
  type CursorAgentsRespondApprovalResult,
} from "@t3tools/contracts";
import {
  installApprovalHooks,
  projectApprovalHookLocation,
  T3_HOOK_SCRIPT_NAME,
  uninstallApprovalHooks,
} from "@t3tools/provider-cursor/server/CursorApprovalHooks";
import {
  CURSOR_HOOK_BRIDGE_STATE_FILE,
  CURSOR_HOOK_TOKEN_ENV,
  CURSOR_HOOK_URL_ENV,
  CURSOR_WORKER_ENV_FILE,
  configureSharedCursorHookBridge,
  sharedCursorHookBridge,
  sharedCursorHookBridgeStarted,
  workerEnvFileContents,
  type CursorHookBridge,
} from "@t3tools/provider-cursor/server/CursorHookBridge";
import {
  makeCursorWorkerApprovals,
  type CursorWorkerApprovals,
} from "@t3tools/provider-cursor/server/CursorWorkerApprovals";
import * as Effect from "effect/Effect";

export interface CursorWorkerHooksDeps {
  readonly stateDir: string;
  readonly approvals?: CursorWorkerApprovals;
  /** Test seam; defaults to the process-wide bridge. */
  readonly bridge?: () => Promise<CursorHookBridge>;
  readonly bridgeStarted?: () => boolean;
}

const fail = (operation: CursorAgentsError["operation"]) => (cause: unknown) =>
  new CursorAgentsError({
    operation,
    detail: cause instanceof Error ? cause.message : String(cause),
  });

export const make = (deps: CursorWorkerHooksDeps) => {
  const stateFile = NodePath.join(deps.stateDir, CURSOR_HOOK_BRIDGE_STATE_FILE);
  const envFile = NodePath.join(deps.stateDir, CURSOR_WORKER_ENV_FILE);
  const approvals = deps.approvals ?? makeCursorWorkerApprovals();
  const bridge = deps.bridge ?? sharedCursorHookBridge;
  const bridgeStarted = deps.bridgeStarted ?? sharedCursorHookBridgeStarted;
  if (deps.bridge === undefined) {
    configureSharedCursorHookBridge({ stateFile, fallback: approvals.ask });
  }

  const startBridge = Effect.tryPromise({
    try: async () => {
      const started = await bridge();
      await NodeFSP.writeFile(envFile, workerEnvFileContents(started), { mode: 0o600 });
      await NodeFSP.chmod(envFile, 0o600);
      return started;
    },
    catch: fail("setup"),
  });

  const fileExists = (file: string) =>
    NodeFSP.access(file).then(
      () => true,
      () => false,
    );

  /**
   * Restart the bridge after a T3 restart when worker approvals were set up
   * before (the persisted state exists), so configured workers keep working.
   */
  const resumeIfConfigured = Effect.promise(() => fileExists(stateFile)).pipe(
    Effect.flatMap((configured) => (configured ? startBridge.pipe(Effect.asVoid) : Effect.void)),
    Effect.catchTags({ CursorAgentsError: (error) => Effect.logWarning(error.message) }),
  );

  const hookSetup = (input: CursorAgentsHookSetupInput) =>
    Effect.gen(function* () {
      const running = bridgeStarted() || input.start === true;
      const started = running ? yield* startBridge : undefined;
      return {
        running: started !== undefined,
        url: started?.url ?? null,
        envFile: started === undefined ? null : envFile,
        urlEnv: CURSOR_HOOK_URL_ENV,
        tokenEnv: CURSOR_HOOK_TOKEN_ENV,
      } satisfies CursorAgentsHookSetup;
    });

  const projectHooks = (input: CursorAgentsProjectHooksInput) =>
    Effect.tryPromise({
      try: async (): Promise<CursorAgentsProjectHooksResult> => {
        if (!NodePath.isAbsolute(input.repoRoot)) {
          throw new Error("Repository path must be absolute.");
        }
        const stat = await NodeFSP.stat(input.repoRoot);
        if (!stat.isDirectory()) throw new Error("Repository path is not a directory.");
        const location = projectApprovalHookLocation(input.repoRoot);
        const hooksFile = NodePath.join(location.cursorDir, "hooks.json");
        if (input.enabled === true) await installApprovalHooks(location);
        if (input.enabled === false) await uninstallApprovalHooks(location);
        const enabled = await NodeFSP.readFile(hooksFile, "utf8").then(
          (text) => text.includes(T3_HOOK_SCRIPT_NAME),
          () => false,
        );
        return { repoRoot: input.repoRoot, enabled, hooksFile };
      },
      catch: fail("projectHooks"),
    });

  const listApprovals = Effect.sync((): CursorAgentsApprovalsResult => ({
    approvals: approvals.pending().map((approval) => ({
      id: approval.id,
      agentId: approval.agentId,
      kind: approval.question.kind,
      title: approval.question.title,
      detail: approval.question.detail,
      workspaceRoots: [...approval.question.workspaceRoots],
      createdAt: approval.createdAt,
    })),
  }));

  const respondApproval = (input: CursorAgentsRespondApprovalInput) =>
    Effect.sync((): CursorAgentsRespondApprovalResult => ({
      found: approvals.respond(input.id, input.decision),
    }));

  return { resumeIfConfigured, hookSetup, projectHooks, listApprovals, respondApproval };
};

export type CursorWorkerHooks = ReturnType<typeof make>;
