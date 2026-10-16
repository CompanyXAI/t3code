// @effect-diagnostics nodeBuiltinImport:off -- runs the generated hook script as Cursor would.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import {
  approvalHookScript,
  installApprovalHooks,
  uninstallApprovalHooks,
  withT3ApprovalHooks,
} from "./CursorApprovalHooks.ts";
import {
  approvalQuestionOf,
  routeQuestion,
  startCursorHookBridge,
  type CursorApprovalQuestion,
  type CursorHookBridge,
} from "./CursorHookBridge.ts";

let dir: string;
let script: string;
let bridge: CursorHookBridge;
const asked: Array<CursorApprovalQuestion> = [];

const runHook = (payload: unknown, env: Record<string, string | undefined>) =>
  new Promise<unknown>((resolve, reject) => {
    const child = NodeChildProcess.spawn(process.execPath, [script], {
      env: { PATH: process.env.PATH, ...env },
    });
    let out = "";
    child.stdout.on("data", (c: Buffer) => (out += c.toString()));
    child.on("error", reject);
    child.on("close", () => resolve(JSON.parse(out)));
    child.stdin.end(JSON.stringify(payload));
  });

beforeAll(async () => {
  dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-cursor-hook-"));
  script = NodePath.join(dir, "hook.cjs");
  await NodeFSP.writeFile(script, approvalHookScript());
  bridge = await startCursorHookBridge();
  bridge.register({
    agentId: () => "agent-1",
    cwd: "/repo",
    decide: async (question) => {
      asked.push(question);
      return question.detail.startsWith("rm") ? "deny" : "allow";
    },
  });
});

afterAll(async () => {
  await bridge.close();
  await NodeFSP.rm(dir, { recursive: true, force: true });
});

describe("Cursor approval hook", () => {
  const env = () => ({ T3_CURSOR_HOOK_URL: bridge.url, T3_CURSOR_HOOK_TOKEN: bridge.token });

  it("is neutral outside T3", async () => {
    expect(await runHook({ hook_event_name: "beforeShellExecution", command: "ls" }, {})).toEqual(
      {},
    );
  });

  it("allows and denies through the bridge", async () => {
    const base = { hook_event_name: "beforeShellExecution", conversation_id: "agent-1" };
    expect(await runHook({ ...base, command: "ls" }, env())).toMatchObject({
      permission: "allow",
    });
    expect(await runHook({ ...base, command: "rm -rf /" }, env())).toMatchObject({
      permission: "deny",
      continue: true,
    });
    expect(asked.map((q) => q.detail)).toEqual(["ls", "rm -rf /"]);
  });

  it("routes file edits by workspace when the id is unknown", async () => {
    const answer = await runHook(
      {
        hook_event_name: "preToolUse",
        conversation_id: "other",
        workspace_roots: ["/repo/sub"],
        tool_name: "Write",
        tool_input: { file_path: "/repo/sub/a.ts" },
      },
      env(),
    );
    expect(answer).toEqual({ permission: "allow" });
    expect(asked.at(-1)).toMatchObject({ kind: "file-change", detail: "/repo/sub/a.ts" });
  });

  it("stays neutral for unowned or ungated requests", async () => {
    expect(
      await runHook({ hook_event_name: "beforeShellExecution", command: "ls", cwd: "/x" }, env()),
    ).toEqual({});
    expect(await runHook({ hook_event_name: "preToolUse", tool_name: "Read" }, env())).toEqual({});
  });

  it("denies on a wrong token or unreachable bridge", async () => {
    const payload = { hook_event_name: "beforeShellExecution", command: "ls" };
    expect(await runHook(payload, { ...env(), T3_CURSOR_HOOK_TOKEN: "wrong" })).toMatchObject({
      permission: "deny",
    });
    expect(
      await runHook(payload, {
        T3_CURSOR_HOOK_URL: "http://127.0.0.1:1/x",
        T3_CURSOR_HOOK_TOKEN: "t",
      }),
    ).toMatchObject({ permission: "deny" });
  });
});

describe("approval routing", () => {
  it("refuses ambiguous workspaces", () => {
    const session = (cwd: string) => ({
      agentId: () => undefined,
      cwd,
      decide: async () => "allow" as const,
    });
    const question = approvalQuestionOf({
      hook_event_name: "beforeShellExecution",
      command: "ls",
      cwd: "/repo",
    })!;
    expect(routeQuestion([session("/repo"), session("/repo")], question)).toBeUndefined();
    expect(routeQuestion([session("/repo"), session("/repository")], question)?.cwd).toBe("/repo");
  });
});

describe("hooks.json installer", () => {
  it("merges idempotently and keeps foreign hooks", () => {
    const foreign = { hooks: { beforeShellExecution: [{ command: "./audit.sh" }] } };
    const once = withT3ApprovalHooks(foreign, "node t3code-approval-hook.cjs");
    const twice = withT3ApprovalHooks(once, "node t3code-approval-hook.cjs");
    expect(twice).toEqual(once);
    expect(once.version).toBe(1);
    expect(once.hooks?.beforeShellExecution).toHaveLength(2);
    expect(once.hooks?.preToolUse?.[0]?.matcher).toContain("Write");
  });

  it("installs and uninstalls on disk", async () => {
    const cursorDir = NodePath.join(dir, ".cursor");
    await NodeFSP.mkdir(cursorDir, { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(cursorDir, "hooks.json"),
      JSON.stringify({ version: 1, hooks: { stop: [{ command: "./done.sh" }] } }),
    );
    const { scriptFile, hooksFile } = await installApprovalHooks({ cursorDir });
    const installed = JSON.parse(await NodeFSP.readFile(hooksFile, "utf8"));
    expect(Object.keys(installed.hooks).sort()).toEqual([
      "beforeMCPExecution",
      "beforeShellExecution",
      "preToolUse",
      "stop",
    ]);
    await NodeFSP.access(scriptFile);
    await uninstallApprovalHooks({ cursorDir });
    expect(JSON.parse(await NodeFSP.readFile(hooksFile, "utf8")).hooks).toEqual({
      stop: [{ command: "./done.sh" }],
    });
  });
  it("restores the user's hooks byte for byte when turned off", async () => {
    const cursorDir = NodePath.join(dir, ".cursor-restore");
    await NodeFSP.mkdir(NodePath.join(cursorDir, "hooks"), { recursive: true });
    const original =
      '{\n    "version": 1,\n    "hooks": { "stop": [ { "command": "./mine.sh" } ] }\n}\n';
    await NodeFSP.writeFile(NodePath.join(cursorDir, "hooks.json"), original);
    await installApprovalHooks({ cursorDir });
    await installApprovalHooks({ cursorDir });
    await uninstallApprovalHooks({ cursorDir });
    expect(await NodeFSP.readFile(NodePath.join(cursorDir, "hooks.json"), "utf8")).toBe(original);
    expect(await NodeFSP.readdir(cursorDir)).toEqual(["hooks", "hooks.json"]);
  });

  it("deletes hooks.json and the hooks folder when T3 created them", async () => {
    const cursorDir = NodePath.join(dir, ".cursor-fresh");
    await installApprovalHooks({ cursorDir });
    await uninstallApprovalHooks({ cursorDir });
    expect(await NodeFSP.readdir(cursorDir)).toEqual([]);
  });

  it("leaves a user's hooks.json untouched when T3 never installed", async () => {
    const cursorDir = NodePath.join(dir, ".cursor-untouched");
    await NodeFSP.mkdir(cursorDir, { recursive: true });
    const original = '{ "version": 1, "hooks": {} }';
    await NodeFSP.writeFile(NodePath.join(cursorDir, "hooks.json"), original);
    await uninstallApprovalHooks({ cursorDir });
    expect(await NodeFSP.readFile(NodePath.join(cursorDir, "hooks.json"), "utf8")).toBe(original);
  });
});
