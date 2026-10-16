// @effect-diagnostics nodeBuiltinImport:off -- git and process lookups run as plain promises at agent creation.
/**
 * Where a T3 chat's Cursor agent runs. Chosen per thread through the
 * "Runs on" model option and fixed when the agent is created; an existing
 * agent stays where it was created (cloud agent ids start with `bc-`).
 *
 * - `local`: Cursor SDK agent inside the T3 server. Visible only in T3.
 * - `worker`: Cloud Agent routed to this account's self-hosted worker
 *   (started from the Cursor agents page). Visible in Cursor.
 * - `cloud`: Cursor-hosted Cloud Agent. Visible in Cursor.
 */
import { execFile } from "node:child_process";
import * as NodePath from "node:path";

import type { ModelSelection, ProviderOptionSelection } from "@t3tools/contracts";
import { buildSelectOptionDescriptor } from "@t3tools/provider-core/server/snapshotProbe";

export const CURSOR_RUNS_ON_OPTION_ID = "runsOn";

export type CursorRunsOn = "local" | "worker" | "cloud";

export const cursorRunsOnDescriptor = () =>
  buildSelectOptionDescriptor({
    id: CURSOR_RUNS_ON_OPTION_ID,
    label: "Runs on",
    options: [
      {
        value: "local",
        label: "This PC (T3 only)",
        description: "Runs inside T3. Not visible in Cursor.",
        isDefault: true,
      },
      {
        value: "worker",
        label: "My worker",
        description: "This account's self-hosted worker. Visible in Cursor.",
      },
      { value: "cloud", label: "Cloud", description: "Cursor Cloud. Visible in Cursor." },
    ],
  });

export function cursorRunsOn(selection: ModelSelection): CursorRunsOn {
  const value = selection.options?.find((option) => option.id === CURSOR_RUNS_ON_OPTION_ID)?.value;
  return value === "worker" || value === "cloud" ? value : "local";
}

/** Model options without the T3-only "Runs on" choice, for the Cursor SDK. */
export function cursorModelOptions(
  options: ReadonlyArray<ProviderOptionSelection> | undefined,
): ReadonlyArray<ProviderOptionSelection> {
  return (options ?? []).filter((option) => option.id !== CURSOR_RUNS_ON_OPTION_ID);
}

export const isCloudAgentId = (agentId: string) => agentId.startsWith("bc-");

/** One instance's worker folder in T3's state folder; the single place this path is built. */
export const cursorWorkerRoot = (stateDir: string, instanceId: string) =>
  NodePath.join(stateDir, "cursor-workers", instanceId);

/** The `--name` a worker process was started with. */
export function workerNameOf(commandLine: string): string | undefined {
  return /--name\s+"?([A-Za-z0-9_.-]{1,64})"?(?:\s|$)/.exec(commandLine)?.[1];
}

const git = (cwd: string, args: ReadonlyArray<string>) =>
  new Promise<string>((resolve, reject) =>
    execFile("git", [...args], { cwd, timeout: 15_000 }, (error, stdout) =>
      error ? reject(error) : resolve(stdout.trim()),
    ),
  );

/** Cursor checks repos out over HTTPS, so an SSH remote becomes its HTTPS form. */
export function httpsRepoUrl(remote: string): string {
  const ssh = /^(?:ssh:\/\/)?git@([^:/]+)[:/](.+?)(?:\.git)?\/?$/.exec(remote);
  return ssh === null ? remote : `https://${ssh[1]}/${ssh[2]}`;
}

/** The project's `origin` URL and current branch, which a remote agent checks out. */
export async function gitRepoTarget(
  cwd: string,
): Promise<{ readonly repoUrl: string; readonly startingRef?: string }> {
  const repoUrl = await git(cwd, ["remote", "get-url", "origin"]).catch(() => "");
  if (repoUrl.length === 0) {
    throw new Error(
      `The project folder '${cwd}' has no git remote 'origin', so a worker or cloud agent cannot check it out`,
    );
  }
  const branch = await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "");
  const url = httpsRepoUrl(repoUrl);
  return branch.length === 0 || branch === "HEAD"
    ? { repoUrl: url }
    : { repoUrl: url, startingRef: branch };
}
