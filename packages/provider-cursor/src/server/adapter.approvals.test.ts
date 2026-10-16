import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Fiber from "effect/Fiber";

import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { CursorSettings } from "../settings.ts";
import { cursorProviderCapabilitiesV2, makeCursorAdapterV2 } from "./adapter.ts";
import type { CursorApprovalSession, CursorHookBridge } from "./CursorHookBridge.ts";
import * as CursorAgentSdk from "./CursorAgentSdk.ts";

const decodeCursorSettings = Schema.decodeEffect(CursorSettings);

const approvalScenario = (options: {
  readonly runtimeMode: "full-access" | "approval-required";
  readonly decision: "accept" | "acceptForSession" | "decline";
}) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const workspace = yield* fileSystem.makeTempDirectoryScoped({ prefix: "cursor-v2-approval-" });
    const release = yield* Deferred.make<void>();
    let cancelled = 0;
    const instanceId = ProviderInstanceId.make("cursor");
    const threadId = ThreadId.make("cursor-approval-thread");
    const modelSelection = { instanceId, model: "composer-2.5" };
    const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
      runtimeMode: options.runtimeMode,
      interactionMode: "default",
      cwd: workspace,
    });
    const sessions: Array<CursorApprovalSession> = [];
    const hookBridge: CursorHookBridge = {
      url: "http://127.0.0.1:0/cursor-hook",
      token: "t",
      register: (session) => {
        sessions.push(session);
        return () => sessions.splice(sessions.indexOf(session), 1);
      },
      handle: async () => null,
      close: async () => {},
    };
    const adapter = yield* makeCursorAdapterV2({
      instanceId,
      hookBridge,
      settings: yield* decodeCursorSettings({ approvalHooks: true }),
      environment: { HOME: workspace },
    }).pipe(
      Effect.provideService(CursorAgentSdk.CursorAgentSdkRunner, {
        assertComplete: Effect.void,
        open: () =>
          Effect.succeed({
            agentId: "native-cursor-approval",
            listMessages: Effect.succeed([]),
            close: Effect.void,
            send: () =>
              Effect.succeed({
                agentId: "native-cursor-approval",
                runId: "native-cursor-approval-run",
                wait: Deferred.await(release).pipe(
                  Effect.as({
                    id: "native-cursor-approval-run",
                    status: "finished" as const,
                    model: { id: "composer-2.5" },
                    durationMs: 1,
                  }),
                ),
                cancel: Effect.sync(() => {
                  cancelled += 1;
                }),
              }),
          }),
      }),
      Effect.provide(TestProviderHost.layer({ cwd: workspace })),
    );
    const runtime = yield* adapter.openSession({
      threadId,
      providerSessionId: ProviderSessionId.make("cursor-approval-session"),
      modelSelection,
      runtimePolicy,
    });
    const providerThread = yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
    const now = yield* DateTime.now;
    yield* runtime.startTurn({
      threadId,
      providerThread,
      modelSelection,
      runtimePolicy,
      runId: RunId.make("cursor-approval-run"),
      runOrdinal: 1,
      providerTurnOrdinal: 1,
      attemptId: RunAttemptId.make("cursor-approval-attempt"),
      rootNodeId: NodeId.make("cursor-approval-root"),
      appThread: {
        id: threadId,
        projectId: ProjectId.make("cursor-approval-project"),
        createdBy: "user" as const,
        creationSource: "web" as const,
        title: "Cursor approvals",
        providerInstanceId: instanceId,
        modelSelection,
        runtimeMode: options.runtimeMode,
        interactionMode: "default" as const,
        branch: null,
        worktreePath: null,
        activeProviderThreadId: providerThread.id,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      },
      message: {
        messageId: MessageId.make("cursor-approval-message"),
        createdBy: "user",
        creationSource: "web",
        text: "start",
        attachments: [],
      },
    });
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]!.agentId(), "native-cursor-approval");
    const question = {
      event: "beforeShellExecution" as const,
      kind: "command" as const,
      title: "Run command",
      detail: "rm -rf build",
      conversationId: "native-cursor-approval",
      workspaceRoots: [workspace],
    };
    const pending = yield* runtime.events.pipe(
      Stream.filter((event) => event.type === "runtime_request.updated"),
      Stream.take(1),
      Stream.runCollect,
      Effect.forkChild,
    );
    const answer = yield* Effect.promise(() => sessions[0]!.decide(question)).pipe(
      Effect.forkChild,
    );
    const asked =
      options.runtimeMode === "approval-required" ? [...(yield* Fiber.join(pending))] : [];
    for (const event of asked) {
      if (event.type === "runtime_request.updated") {
        assert.equal(event.runtimeRequest.kind, "command");
        assert.equal(event.runtimeRequest.status, "pending");
        yield* runtime.respondToRuntimeRequest({
          requestId: event.runtimeRequest.id,
          decision: options.decision,
        });
      }
    }
    const first = yield* Fiber.join(answer);
    // A session-wide approval answers the same command again without asking.
    const second =
      options.decision === "acceptForSession"
        ? yield* Effect.promise(() => sessions[0]!.decide(question))
        : undefined;
    const unknown = yield* runtime
      .respondToRuntimeRequest({ requestId: "missing" as never, decision: "accept" })
      .pipe(Effect.result);
    yield* Deferred.succeed(release, undefined);
    return { asked: asked.length, first, second, unknown };
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(NodeServices.layer, IdAllocator.layer, McpProviderSessions.layer),
    ),
  );

describe("CursorAdapterV2 hook approvals", () => {
  it("advertises command and file-change approvals only with hooks", () => {
    assert.isFalse(cursorProviderCapabilitiesV2(false).approvals.supportsCommandApproval);
    const caps = cursorProviderCapabilitiesV2(true).approvals;
    assert.isTrue(caps.supportsCommandApproval);
    assert.isTrue(caps.supportsFileChangeApproval);
  });

  it.effect("allows without asking in full-access mode", () =>
    Effect.gen(function* () {
      const result = yield* approvalScenario({ runtimeMode: "full-access", decision: "accept" });
      assert.equal(result.asked, 0);
      assert.equal(result.first, "allow");
    }),
  );

  it.effect("asks T3 and allows on accept", () =>
    Effect.gen(function* () {
      const result = yield* approvalScenario({
        runtimeMode: "approval-required",
        decision: "accept",
      });
      assert.equal(result.asked, 1);
      assert.equal(result.first, "allow");
      assert.equal(result.unknown._tag, "Failure");
    }),
  );

  it.effect("denies on decline", () =>
    Effect.gen(function* () {
      const result = yield* approvalScenario({
        runtimeMode: "approval-required",
        decision: "decline",
      });
      assert.equal(result.first, "deny");
    }),
  );

  it.effect("remembers acceptForSession", () =>
    Effect.gen(function* () {
      const result = yield* approvalScenario({
        runtimeMode: "approval-required",
        decision: "acceptForSession",
      });
      assert.equal(result.first, "allow");
      assert.equal(result.second, "allow");
    }),
  );
});
