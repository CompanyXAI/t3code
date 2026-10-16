// @effect-diagnostics nodeBuiltinImport:off -- installs a documented Cursor hooks.json entry on disk.
/**
 * Installs T3's approval hook into a Cursor `hooks.json` (user level for
 * local SDK agents, `<repo>/.cursor/hooks.json` for Self-Hosted Machines
 * worker runs, which only load project hooks). Opt-in only; the installer
 * never removes hooks it did not write.
 *
 * The hook script is neutral outside T3: without `T3_CURSOR_HOOK_URL` in its
 * environment (Cursor IDE, CLI, or another client) it prints `{}` so Cursor
 * keeps its normal permission flow. Inside T3 it blocks until the user
 * decides, and denies when T3 cannot be reached.
 *
 * @module provider-cursor/server/CursorApprovalHooks
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  CURSOR_HOOK_TOKEN_ENV,
  CURSOR_HOOK_URL_ENV,
  type CursorHookEventName,
} from "./CursorHookBridge.ts";

export const T3_HOOK_SCRIPT_NAME = "t3code-approval-hook.cjs";
/** Seconds Cursor waits for a decision before failing the hook. */
export const T3_HOOK_TIMEOUT_SECONDS = 3600;
export const DEFAULT_APPROVAL_HOOK_EVENTS: ReadonlyArray<CursorHookEventName> = [
  "beforeShellExecution",
  "beforeMCPExecution",
  "preToolUse",
];

export function approvalHookScript(): string {
  return `#!/usr/bin/env node
// Written by T3 Code. Forwards Cursor permission hooks to T3's approval UI.
"use strict";
const url = process.env.${CURSOR_HOOK_URL_ENV};
const token = process.env.${CURSOR_HOOK_TOKEN_ENV};
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", async () => {
  if (!url || !token) {
    process.stdout.write("{}");
    return;
  }
  let event;
  try { event = JSON.parse(raw).hook_event_name; } catch {}
  const deny = (why) => {
    const out = { permission: "deny", user_message: why, agent_message: why };
    if (event === "beforeShellExecution") out.continue = true;
    process.stdout.write(JSON.stringify(out));
  };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + token },
      body: raw,
    });
    if (!res.ok) return deny("T3 Code rejected the approval request (HTTP " + res.status + ").");
    const body = await res.json();
    process.stdout.write(JSON.stringify(body.answer ?? {}));
  } catch (error) {
    deny("T3 Code approval bridge unreachable: " + (error && error.message));
  }
});
`;
}

interface HookEntry {
  readonly command: string;
  readonly matcher?: string;
  readonly timeout?: number;
  readonly [key: string]: unknown;
}

interface HooksFile {
  readonly version?: number;
  readonly hooks?: Record<string, ReadonlyArray<HookEntry>>;
  readonly [key: string]: unknown;
}

const isT3Entry = (entry: HookEntry) =>
  typeof entry.command === "string" && entry.command.includes(T3_HOOK_SCRIPT_NAME);

/** Adds T3's hook to every event, replacing earlier T3 entries; keeps others. */
export function withT3ApprovalHooks(
  existing: HooksFile | undefined,
  command: string,
  events: ReadonlyArray<CursorHookEventName> = DEFAULT_APPROVAL_HOOK_EVENTS,
): HooksFile {
  const hooks: Record<string, ReadonlyArray<HookEntry>> = {};
  for (const [name, entries] of Object.entries(existing?.hooks ?? {})) {
    const kept = entries.filter((entry) => !isT3Entry(entry));
    if (kept.length > 0) hooks[name] = kept;
  }
  for (const event of events) {
    hooks[event] = [
      ...(hooks[event] ?? []),
      {
        command,
        timeout: T3_HOOK_TIMEOUT_SECONDS,
        ...(event === "preToolUse" ? { matcher: "Write|Delete|Edit|MultiEdit|ApplyPatch" } : {}),
      },
    ];
  }
  return { ...existing, version: existing?.version ?? 1, hooks };
}

/** Removes only T3's entries. */
export function withoutT3ApprovalHooks(existing: HooksFile | undefined): HooksFile {
  return withT3ApprovalHooks(existing, "", []);
}

const readHooks = async (file: string): Promise<HooksFile | undefined> => {
  try {
    return JSON.parse(await NodeFSP.readFile(file, "utf8")) as HooksFile;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  }
};

export interface ApprovalHookLocation {
  /** `~/.cursor` for user hooks, `<repo>/.cursor` for project hooks. */
  readonly cursorDir: string;
  /** Command as Cursor should run it; project hooks resolve from the repo root. */
  readonly command?: string;
}

export async function installApprovalHooks(
  location: ApprovalHookLocation,
  events: ReadonlyArray<CursorHookEventName> = DEFAULT_APPROVAL_HOOK_EVENTS,
): Promise<{ readonly hooksFile: string; readonly scriptFile: string }> {
  const scriptFile = NodePath.join(location.cursorDir, "hooks", T3_HOOK_SCRIPT_NAME);
  const hooksFile = NodePath.join(location.cursorDir, "hooks.json");
  await snapshotBeforeFirstInstall(location.cursorDir);
  await NodeFSP.mkdir(NodePath.dirname(scriptFile), { recursive: true });
  await NodeFSP.writeFile(scriptFile, approvalHookScript(), { mode: 0o755 });
  const next = withT3ApprovalHooks(
    await readHooks(hooksFile),
    location.command ?? `node ${JSON.stringify(scriptFile)}`,
    events,
  );
  await NodeFSP.writeFile(hooksFile, `${JSON.stringify(next, null, 2)}\n`);
  return { hooksFile, scriptFile };
}

/** What T3 found before its first install, so turning hooks off can put it back. */
const snapshotFile = (cursorDir: string) => NodePath.join(cursorDir, ".t3code-hooks-before.json");

interface HooksSnapshot {
  /** Original hooks.json bytes (utf8), or null when there was none. */
  readonly hooksJson: string | null;
  readonly hooksDirExisted: boolean;
}

const exists = (path: string) =>
  NodeFSP.access(path).then(
    () => true,
    () => false,
  );

async function snapshotBeforeFirstInstall(cursorDir: string): Promise<void> {
  if (await exists(snapshotFile(cursorDir))) return;
  const hooksFile = NodePath.join(cursorDir, "hooks.json");
  const snapshot: HooksSnapshot = {
    hooksJson: (await exists(hooksFile)) ? await NodeFSP.readFile(hooksFile, "utf8") : null,
    hooksDirExisted: await exists(NodePath.join(cursorDir, "hooks")),
  };
  await NodeFSP.mkdir(cursorDir, { recursive: true });
  await NodeFSP.writeFile(snapshotFile(cursorDir), JSON.stringify(snapshot));
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const hasT3Entry = (file: HooksFile) =>
  Object.values(file.hooks ?? {}).some((entries) => entries.some(isT3Entry));

/**
 * Removes only T3's entries and script. When nothing else changed since the
 * first install, hooks.json is restored byte for byte (or deleted if T3 created
 * it), and a hooks folder T3 created is removed once empty.
 */
export async function uninstallApprovalHooks(location: ApprovalHookLocation): Promise<void> {
  const hooksFile = NodePath.join(location.cursorDir, "hooks.json");
  const snapshotPath = snapshotFile(location.cursorDir);
  const snapshot = (await exists(snapshotPath))
    ? (JSON.parse(await NodeFSP.readFile(snapshotPath, "utf8")) as HooksSnapshot)
    : undefined;
  const existing = await readHooks(hooksFile);
  if (existing !== undefined) {
    const cleaned = withoutT3ApprovalHooks(existing);
    const before =
      snapshot === undefined
        ? undefined
        : snapshot.hooksJson === null
          ? withoutT3ApprovalHooks(undefined)
          : withoutT3ApprovalHooks(JSON.parse(snapshot.hooksJson) as HooksFile);
    if (before !== undefined && sameJson(cleaned, before)) {
      if (snapshot?.hooksJson == null) await NodeFSP.rm(hooksFile, { force: true });
      else await NodeFSP.writeFile(hooksFile, snapshot.hooksJson);
    } else if (hasT3Entry(existing)) {
      await NodeFSP.writeFile(hooksFile, `${JSON.stringify(cleaned, null, 2)}\n`);
    }
  }
  const hooksDir = NodePath.join(location.cursorDir, "hooks");
  await NodeFSP.rm(NodePath.join(hooksDir, T3_HOOK_SCRIPT_NAME), { force: true });
  if (snapshot !== undefined && !snapshot.hooksDirExisted) {
    await NodeFSP.rmdir(hooksDir).catch(() => undefined);
  }
  await NodeFSP.rm(snapshotPath, { force: true });
}

/**
 * Project-level location for Self-Hosted Machines worker runs, which load
 * only `<repo>/.cursor/hooks.json`. Cursor runs project hooks from the repo
 * root, so the command is repo-relative and the script can be committed.
 */
export function projectApprovalHookLocation(repoRoot: string): ApprovalHookLocation {
  return {
    cursorDir: NodePath.join(repoRoot, ".cursor"),
    command: `node .cursor/hooks/${T3_HOOK_SCRIPT_NAME}`,
  };
}
