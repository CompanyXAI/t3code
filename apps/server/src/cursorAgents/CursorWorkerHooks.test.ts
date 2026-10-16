// @effect-diagnostics nodeBuiltinImport:off -- checks files the worker setup writes.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { makeCursorWorkerApprovals } from "@t3tools/provider-cursor/server/CursorWorkerApprovals";

import * as CursorWorkerHooks from "./CursorWorkerHooks.ts";

const withDir = <A, E>(use: (dir: string) => Effect.Effect<A, E>) =>
  Effect.acquireUseRelease(
    Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-worker-hooks-"))),
    use,
    (dir) => Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true })),
  );

const fakeBridge = (started: { value: boolean }) => ({
  bridgeStarted: () => started.value,
  bridge: async () => {
    started.value = true;
    return {
      url: "http://127.0.0.1:4567/cursor-hook",
      token: "secret-token",
      register: () => () => {},
      handle: async () => null,
      close: async () => {},
    };
  },
});

describe("CursorWorkerHooks", () => {
  it.effect("reports off until started, then writes an owner-only env file", () =>
    withDir((dir) =>
      Effect.gen(function* () {
        const hooks = CursorWorkerHooks.make({ stateDir: dir, ...fakeBridge({ value: false }) });
        const off = yield* hooks.hookSetup({});
        assert.isFalse(off.running);
        assert.isNull(off.envFile);
        const on = yield* hooks.hookSetup({ start: true });
        assert.isTrue(on.running);
        assert.equal(on.url, "http://127.0.0.1:4567/cursor-hook");
        assert.notInclude(JSON.stringify(on), "secret-token");
        const envFile = on.envFile!;
        const text = yield* Effect.promise(() => NodeFSP.readFile(envFile, "utf8"));
        assert.include(text, 'T3_CURSOR_HOOK_TOKEN="secret-token"');
        const mode = (yield* Effect.promise(() => NodeFSP.stat(envFile))).mode & 0o777;
        if ((yield* HostProcess.Platform) !== "win32") assert.equal(mode, 0o600);
      }),
    ),
  );

  it.effect("installs and removes project hooks in a repository", () =>
    withDir((dir) =>
      Effect.gen(function* () {
        const hooks = CursorWorkerHooks.make({ stateDir: dir, ...fakeBridge({ value: true }) });
        const repo = NodePath.join(dir, "repo");
        yield* Effect.promise(() => NodeFSP.mkdir(repo));
        assert.isFalse((yield* hooks.projectHooks({ repoRoot: repo })).enabled);
        const installed = yield* hooks.projectHooks({ repoRoot: repo, enabled: true });
        assert.isTrue(installed.enabled);
        const json = yield* Effect.promise(() => NodeFSP.readFile(installed.hooksFile, "utf8"));
        assert.include(json, "node .cursor/hooks/t3code-approval-hook.cjs");
        assert.isFalse((yield* hooks.projectHooks({ repoRoot: repo, enabled: false })).enabled);
        const relative = yield* hooks.projectHooks({ repoRoot: "repo" }).pipe(Effect.flip);
        assert.equal(relative.operation, "projectHooks");
      }),
    ),
  );

  it.effect("lists worker approvals and forwards the answer", () =>
    withDir((dir) =>
      Effect.gen(function* () {
        const approvals = makeCursorWorkerApprovals();
        const hooks = CursorWorkerHooks.make({
          stateDir: dir,
          approvals,
          ...fakeBridge({ value: true }),
        });
        const answer = approvals.ask({
          event: "preToolUse",
          kind: "file-change",
          title: "Edit file",
          detail: "/repo/a.ts",
          conversationId: "bc-1",
          workspaceRoots: ["/repo"],
        });
        const listed = yield* hooks.listApprovals;
        assert.equal(listed.approvals.length, 1);
        assert.equal(listed.approvals[0]!.agentId, "bc-1");
        const result = yield* hooks.respondApproval({
          id: listed.approvals[0]!.id,
          decision: "allow",
        });
        assert.isTrue(result.found);
        assert.equal(yield* Effect.promise(() => answer), "allow");
      }),
    ),
  );
});
