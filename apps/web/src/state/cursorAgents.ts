import { WS_METHODS, type CursorAgentStreamEvent } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import * as Stream from "effect/Stream";

import { connectionAtomRuntime } from "../connection/runtime";

/** Max lines kept per followed agent; older lines scroll out. */
export const CURSOR_AGENT_LOG_LIMIT = 500;

/**
 * Every Cursor agent of every enabled Cursor account on an environment: local
 * SDK agents, own-machine workers, Cloud Agents and Self-Hosted pools/machines.
 * Cloud lists are remote calls, so the list refreshes on a slow interval.
 */
export const cursorAgentList = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:cursor-agents:list",
  tag: WS_METHODS.cursorAgentsList,
  staleTimeMs: 10_000,
  idleTtlMs: 5 * 60_000,
  refreshIntervalMs: 30_000,
});

/** Live lines of one agent's latest run, accumulated for display. */
export const cursorAgentLog = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "environment-data:cursor-agents:follow",
  tag: WS_METHODS.cursorAgentsFollow,
  idleTtlMs: 0,
  transform: (stream) =>
    stream.pipe(
      Stream.scan(
        (): ReadonlyArray<CursorAgentStreamEvent> => [],
        (lines: ReadonlyArray<CursorAgentStreamEvent>, line: CursorAgentStreamEvent) =>
          [...lines, line].slice(-CURSOR_AGENT_LOG_LIMIT),
      ),
    ),
});

export const cursorAgentLaunch = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:cursor-agents:launch",
  tag: WS_METHODS.cursorAgentsLaunch,
});

export const cursorAgentFollowUp = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:cursor-agents:follow-up",
  tag: WS_METHODS.cursorAgentsFollowUp,
});

export const cursorAgentStop = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:cursor-agents:stop",
  tag: WS_METHODS.cursorAgentsStop,
});

/** Hook requests of worker agents waiting for an answer on the agents page. */
export const cursorWorkerApprovals = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:cursor-agents:approvals",
  tag: WS_METHODS.cursorAgentsApprovals,
  staleTimeMs: 0,
  idleTtlMs: 60_000,
  refreshIntervalMs: 2_000,
});

export const cursorWorkerApprovalRespond = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:cursor-agents:respond-approval",
  tag: WS_METHODS.cursorAgentsRespondApproval,
});

/** Bridge status read without starting it (`start` omitted). */
export const cursorWorkerHookSetup = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:cursor-agents:hook-setup",
  tag: WS_METHODS.cursorAgentsHookSetup,
  staleTimeMs: 0,
  idleTtlMs: 60_000,
  refreshIntervalMs: 5_000,
});

export const cursorWorkerHookStart = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:cursor-agents:hook-start",
  tag: WS_METHODS.cursorAgentsHookSetup,
});

/** Whether a repository has T3's project hooks (`enabled` omitted reads only). */
export const cursorProjectHooksState = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:cursor-agents:project-hooks",
  tag: WS_METHODS.cursorAgentsProjectHooks,
  staleTimeMs: 0,
  idleTtlMs: 60_000,
  refreshIntervalMs: 5_000,
});

export const cursorProjectHooksSet = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:cursor-agents:project-hooks-set",
  tag: WS_METHODS.cursorAgentsProjectHooks,
});

/** CLI profile login and worker state of one Cursor instance (`action: "status"`). */
export const cursorMachineState = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:cursor-agents:machine",
  tag: WS_METHODS.cursorAgentsMachine,
  staleTimeMs: 0,
  idleTtlMs: 60_000,
  refreshIntervalMs: 10_000,
});

export const cursorMachineAction = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:cursor-agents:machine-action",
  tag: WS_METHODS.cursorAgentsMachine,
});
