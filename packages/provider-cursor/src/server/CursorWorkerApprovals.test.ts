// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalTimers:off -- drives the loopback bridge like a hook process.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";
import * as HostProcess from "@t3tools/shared/HostProcess";

import {
  loadOrCreateBridgeState,
  startCursorHookBridge,
  workerEnvFileContents,
  type CursorApprovalQuestion,
} from "./CursorHookBridge.ts";
import { makeCursorWorkerApprovals } from "./CursorWorkerApprovals.ts";

const question: CursorApprovalQuestion = {
  event: "beforeShellExecution",
  kind: "command",
  title: "Run command",
  detail: "pnpm test",
  conversationId: "bc-worker-1",
  workspaceRoots: ["/repo"],
};

describe("CursorWorkerApprovals", () => {
  it("parks a request until the user answers", async () => {
    const approvals = makeCursorWorkerApprovals();
    let changes = 0;
    approvals.subscribe(() => (changes += 1));
    const answer = approvals.ask(question);
    const [pending] = approvals.pending();
    expect(pending).toMatchObject({ agentId: "bc-worker-1", question });
    expect(approvals.respond(pending!.id, "allow")).toBe(true);
    expect(await answer).toBe("allow");
    expect(approvals.pending()).toEqual([]);
    expect(approvals.respond(pending!.id, "deny")).toBe(false);
    expect(changes).toBe(2);
  });

  it("stays neutral without an agent id and denies on timeout", async () => {
    const approvals = makeCursorWorkerApprovals({ timeoutMs: 5 });
    expect(await approvals.ask({ ...question, conversationId: undefined })).toBeNull();
    expect(await approvals.ask(question)).toBe("deny");
  });

  it("answers unowned worker hooks through the bridge fallback", async () => {
    const approvals = makeCursorWorkerApprovals();
    const bridge = await startCursorHookBridge({ fallback: approvals.ask });
    try {
      const response = fetch(bridge.url, {
        method: "POST",
        headers: { authorization: `Bearer ${bridge.token}` },
        body: JSON.stringify({
          hook_event_name: "beforeShellExecution",
          conversation_id: "bc-worker-1",
          command: "rm -rf dist",
        }),
      }).then((res) => res.json());
      while (approvals.pending().length === 0) await new Promise((r) => setTimeout(r, 5));
      approvals.respond(approvals.pending()[0]!.id, "deny");
      expect((await response).answer).toMatchObject({ permission: "deny" });
    } finally {
      await bridge.close();
    }
  });
});

describe("persisted bridge state", () => {
  it("keeps token and port across restarts in an owner-only file", async () => {
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-bridge-state-"));
    const file = NodePath.join(dir, "state", "cursor-hook-bridge.json");
    try {
      const first = await loadOrCreateBridgeState(file);
      expect(first.token).toHaveLength(64);
      // Windows has no POSIX modes; the user-profile ACL protects the file there.
      if (HostProcess.Platform.defaultValue() !== "win32") {
        expect((await NodeFSP.stat(file)).mode & 0o777).toBe(0o600);
      }
      expect(await loadOrCreateBridgeState(file)).toEqual(first);

      const a = await startCursorHookBridge({ token: first.token });
      const port = Number(new URL(a.url).port);
      await a.close();
      const b = await startCursorHookBridge({ token: first.token, port });
      expect(b.url).toBe(a.url);
      expect(b.token).toBe(first.token);
      // A busy port falls back to a free one instead of failing.
      const c = await startCursorHookBridge({ port });
      expect(c.url).not.toBe(b.url);
      await Promise.all([b.close(), c.close()]);
      expect(workerEnvFileContents(b)).toContain(`T3_CURSOR_HOOK_URL="${b.url}"`);
    } finally {
      await NodeFSP.rm(dir, { recursive: true, force: true });
    }
  });
});
